import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // The browser only ever talks to this dev server, so the API needs no CORS.
    proxy: { "/api": "http://127.0.0.1:3001" },
  },
});
