import { useEffect, useState } from "react";
import "./App.css";

const MB = 1024 * 1024;
// These match the limits the server enforces.
const MAX_FILES = 20;
const MAX_FILE_MB = 20;
const MAX_TOTAL_MB = 50;

function kindOf(file) {
  if (file.type === "image/jpeg" || /\.jpe?g$/i.test(file.name)) return "jpg";
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) return "pdf";
  return null;
}

const formatSize = (bytes) =>
  bytes < MB
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / MB).toFixed(1)} MB`;

// Each chosen file gets its own id, so the same file can be added more than once.
let nextId = 0;

function Thumbnail({ file }) {
  const [url, setUrl] = useState(null);

  // Release the in-memory blob when the file is removed or the page closes.
  useEffect(() => {
    const created = URL.createObjectURL(file);
    setUrl(created);
    return () => URL.revokeObjectURL(created);
  }, [file]);

  return url ? <img className="thumb" src={url} alt="" /> : <span className="thumb" />;
}

export default function App() {
  // The chosen files as { id, file }, in the order their pages will appear.
  const [items, setItems] = useState([]);
  const [pdfUrl, setPdfUrl] = useState(null);
  const [converting, setConverting] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);

  // Release the in-memory PDF when it is replaced or the page closes.
  useEffect(() => () => pdfUrl && URL.revokeObjectURL(pdfUrl), [pdfUrl]);

  // Any change to the list makes an earlier result out of date.
  function updateItems(next) {
    setItems(next);
    setPdfUrl(null);
  }

  function addFiles(picked) {
    const next = [...items];
    const problems = [];
    let total = items.reduce((sum, item) => sum + item.file.size, 0);

    for (const file of picked) {
      if (!kindOf(file)) {
        problems.push(`"${file.name}" isn't a JPG or a PDF, so it was left out.`);
      } else if (file.size > MAX_FILE_MB * MB) {
        problems.push(
          `"${file.name}" is over the ${MAX_FILE_MB} MB limit, so it was left out.`
        );
      } else if (next.length >= MAX_FILES) {
        problems.push(`Only ${MAX_FILES} files fit in one PDF. The rest were left out.`);
        break;
      } else if (total + file.size > MAX_TOTAL_MB * MB) {
        problems.push(
          `"${file.name}" would take the total over ${MAX_TOTAL_MB} MB, so it was left out.`
        );
      } else {
        total += file.size;
        next.push({ id: nextId++, file });
      }
    }

    setError(problems.join("\n"));
    if (next.length > items.length) updateItems(next);
  }

  function move(index, step) {
    const next = [...items];
    [next[index], next[index + step]] = [next[index + step], next[index]];
    updateItems(next);
  }

  function remove(id) {
    setError("");
    updateItems(items.filter((item) => item.id !== id));
  }

  async function convert() {
    setConverting(true);
    setError("");
    try {
      const body = new FormData();
      for (const { file } of items) body.append("files", file);

      let res;
      try {
        res = await fetch("/api/convert", { method: "POST", body });
      } catch {
        throw new Error("Couldn't reach the server. Check that it is running.");
      }
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || `Conversion failed (error ${res.status}).`);
      }

      setPdfUrl(URL.createObjectURL(await res.blob()));
    } catch (err) {
      setError(err.message);
    } finally {
      setConverting(false);
    }
  }

  const many = items.length > 1;
  // A PDF on its own has nothing to be combined with.
  const needsMore = items.length === 1 && kindOf(items[0].file) === "pdf";

  let pdfName = "";
  if (many) pdfName = "combined.pdf";
  else if (items.length === 1) {
    pdfName = items[0].file.name.replace(/\.(jpe?g|pdf)$/i, "") + ".pdf";
  }

  let action = many ? "Combine into one PDF" : "Convert to PDF";
  if (converting) action = many ? "Combining…" : "Converting…";

  return (
    <main className="card">
      <h1>JPG to PDF</h1>
      <p className="lede">
        Turn photos into a PDF, or combine JPGs and PDFs into one. Nothing is stored.
      </p>

      <label
        className={`dropzone${items.length ? " compact" : ""}${dragging ? " dragging" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          // The list is locked while a conversion is under way.
          if (!converting) addFiles([...e.dataTransfer.files]);
        }}
      >
        <input
          type="file"
          multiple
          accept="image/jpeg,.jpg,.jpeg,application/pdf,.pdf"
          disabled={converting}
          onChange={(e) => {
            addFiles([...e.target.files]);
            e.target.value = "";
          }}
        />
        <span className="prompt">
          {items.length ? "Add more files" : "Choose JPGs or PDFs"}
        </span>
        <span className="hint">
          or drag them here, up to {MAX_FILE_MB} MB each and {MAX_TOTAL_MB} MB in total
        </span>
      </label>

      {many && <p className="hint order-note">Pages will follow this order.</p>}

      {items.length > 0 && (
        <ol className="files">
          {items.map(({ id, file }, index) => (
            <li key={id}>
              {kindOf(file) === "pdf" ? (
                <span className="thumb">PDF</span>
              ) : (
                <Thumbnail file={file} />
              )}
              <span className="file-text">
                <span className="filename">{file.name}</span>
                <span className="hint">{formatSize(file.size)}</span>
              </span>
              <span className="file-actions">
                {many && (
                  <>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Move ${file.name} up`}
                      disabled={converting || index === 0}
                      onClick={() => move(index, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Move ${file.name} down`}
                      disabled={converting || index === items.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      ↓
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove ${file.name}`}
                  disabled={converting}
                  onClick={() => remove(id)}
                >
                  ✕
                </button>
              </span>
            </li>
          ))}
        </ol>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {needsMore && (
        <p className="hint order-note">
          That is already a PDF. Add another file to combine it with.
        </p>
      )}

      {pdfUrl ? (
        <a className="button" href={pdfUrl} download={pdfName}>
          Download {pdfName}
        </a>
      ) : (
        <button
          className="button"
          onClick={convert}
          disabled={items.length === 0 || needsMore || converting}
        >
          {action}
        </button>
      )}
    </main>
  );
}
