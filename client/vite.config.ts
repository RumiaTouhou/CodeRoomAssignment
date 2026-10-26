import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
const root = fileURLToPath(new URL(".", import.meta.url));
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  server: {
    fs: { allow: [resolve(root, "..")] },
    proxy: { "/api": "http://127.0.0.1:8080", "/ws": { target: "ws://127.0.0.1:8080", ws: true } },
  },
  build: mode === "ui-preview" ? {
    outDir: "dist-preview", emptyOutDir: true, rollupOptions: { input: resolve(root, "preview.html") },
  } : { outDir: "dist", emptyOutDir: true, rollupOptions: { input: resolve(root, "index.html") } },
}));
