import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import { rateLimit } from "express-rate-limit";
import multer from "multer";
import { PDFDocument as PdfLibDocument } from "pdf-lib";
import PDFDocument from "pdfkit";

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || "127.0.0.1";
// How many reverse proxies sit in front of this server (0 when it is reached directly).
const TRUST_PROXY = Number(process.env.TRUST_PROXY) || 0;
const MB = 1024 * 1024;
const MAX_FILES = 20;
const MAX_FILE_BYTES = 20 * MB;
const MAX_TOTAL_BYTES = 50 * MB;
// The upload's own framing adds a little on top of the files themselves.
const MAX_REQUEST_BYTES = MAX_TOTAL_BYTES + MB;
// PDF readers reject pages larger than 200 inches (14400 points) on a side.
const MAX_PAGE_PT = 14400;
const CONVERSIONS_PER_MINUTE = 20;
// Where `npm run build` in the client leaves the finished page.
const CLIENT_DIST = fileURLToPath(new URL("../client/dist", import.meta.url));

const app = express();

// Behind a proxy every request arrives from the proxy's own address, so all visitors
// would share one rate limit. This makes Express read the visitor's address instead.
if (TRUST_PROXY) app.set("trust proxy", TRUST_PROXY);

// Each address gets a fixed number of conversions per minute. Counts live in this
// process's memory, so they reset on restart and are not shared between instances.
const convertLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: CONVERSIONS_PER_MINUTE,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: (req, res) =>
    refuse(req, res, 429, "Too many conversions. Wait a minute and try again."),
});

// Turn a request away without parsing its upload. The rest of the upload is read and
// discarded first: replying while files are still being sent makes proxies report a
// dropped connection instead of this message.
function refuse(req, res, status, error) {
  req.resume().once("end", () => res.status(status).json({ error }));
}

// Uploads are held in memory, so the whole request is capped as well as each file.
function checkRequestSize(req, res, next) {
  const length = Number(req.headers["content-length"]);
  if (Number.isNaN(length)) {
    return refuse(req, res, 411, "The upload did not say how large it is.");
  }
  if (length > MAX_REQUEST_BYTES) {
    return refuse(
      req,
      res,
      413,
      `Those files add up to more than the ${MAX_TOTAL_BYTES / MB} MB limit.`
    );
  }
  next();
}

// Files are held in memory for the length of one request and never written to disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES },
  // Browsers send file names as UTF-8.
  defParamCharset: "utf8",
});

// Check the file's own leading bytes; the name and MIME type are whatever the client claims.
const isJpeg = (buf) =>
  buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
// A PDF's header may sit anywhere in its first 1024 bytes.
const isPdf = (buf) => buf.subarray(0, 1024).includes("%PDF-");

// An uploaded file that cannot be used. The message is shown to the user as it is.
class BadFileError extends Error {}

const unreadable = (name) =>
  new BadFileError(`"${name}" could not be read. It may be damaged.`);

// One page per photo, in the order given.
function jpgsToPdf(photos) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ autoFirstPage: false });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    try {
      for (const photo of photos) {
        try {
          const image = doc.openImage(photo.buffer);
          let { width, height } = image;
          // EXIF orientations 5-8 mean the photo is stored sideways.
          if (image.orientation > 4) [width, height] = [height, width];

          const scale = Math.min(1, MAX_PAGE_PT / Math.max(width, height));
          width *= scale;
          height *= scale;

          // A page exactly the size of the image, with no margins.
          doc.addPage({ size: [width, height], margin: 0 });
          doc.image(image, 0, 0, { width, height });
        } catch {
          throw unreadable(photo.name);
        }
      }
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// `inputs` is a list of { name, buffer, pdf } in the order the pages should appear.
async function buildPdf(inputs) {
  if (inputs.every((input) => !input.pdf)) return jpgsToPdf(inputs);

  // With PDFs in the mix, each photo becomes a one-page PDF of its own, and the pages
  // of every document are copied in turn into a new one.
  const merged = await PdfLibDocument.create();
  for (const input of inputs) {
    const bytes = input.pdf ? input.buffer : await jpgsToPdf([input]);
    try {
      // Encryption is ignored while loading only so that a locked file can be told
      // apart from a damaged one.
      const source = await PdfLibDocument.load(bytes, { ignoreEncryption: true });
      if (source.isEncrypted) {
        throw new BadFileError(
          `"${input.name}" is password-protected, so it can't be combined.`
        );
      }
      const pages = await merged.copyPages(source, source.getPageIndices());
      for (const page of pages) merged.addPage(page);
    } catch (err) {
      throw err instanceof BadFileError ? err : unreadable(input.name);
    }
  }
  return Buffer.from(await merged.save());
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

// The limiter and the size check run before the upload is parsed, so files that are
// turned away are never held in memory.
app.post(
  "/api/convert",
  convertLimiter,
  checkRequestSize,
  upload.array("files", MAX_FILES),
  async (req, res) => {
    const files = req.files ?? [];
    if (files.length === 0) {
      return res.status(400).json({ error: "No files were uploaded." });
    }

    const inputs = [];
    for (const { originalname: name, buffer } of files) {
      const jpg = isJpeg(buffer);
      if (!jpg && !isPdf(buffer)) {
        return res.status(415).json({ error: `"${name}" is not a JPG or a PDF.` });
      }
      inputs.push({ name, buffer, pdf: !jpg });
    }

    let pdf;
    try {
      pdf = await buildPdf(inputs);
    } catch (err) {
      if (err instanceof BadFileError) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }

    // One file keeps its own name; several become "combined.pdf".
    let base = "combined";
    if (inputs.length === 1) {
      base =
        inputs[0].name
          .replace(/\.(jpe?g|pdf)$/i, "")
          .replace(/[^\w.-]+/g, "_")
          .slice(0, 100) || "image";
    }

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${base}.pdf"`,
      "Cache-Control": "no-store",
    });
    res.send(pdf);
  }
);

// Once the client has been built, this server hosts the page as well as the API, so a
// single service is enough in production. In development Vite serves the page instead.
if (existsSync(CLIENT_DIST)) app.use(express.static(CLIENT_DIST));

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const tooBig = err.code === "LIMIT_FILE_SIZE";
    return res.status(tooBig ? 413 : 400).json({
      error: tooBig
        ? `Each file can be up to ${MAX_FILE_BYTES / MB} MB.`
        : `Upload up to ${MAX_FILES} JPG or PDF files at a time.`,
    });
  }
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server." });
});

app.listen(PORT, HOST, () => {
  console.log(`API listening on http://${HOST}:${PORT}`);
});
