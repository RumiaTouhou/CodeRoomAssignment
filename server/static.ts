import type { ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".wav": "audio/wav",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export async function serveStatic(directory: string, pathname: string, method: string, response: ServerResponse): Promise<boolean> {
  if (method !== "GET" && method !== "HEAD") return false;
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return false; }
  if (decoded.includes("\0") || decoded.includes("\\") || decoded.split("/").includes("..")) return false;
  const root = resolve(directory);
  const file = resolve(root, "." + (decoded === "/" ? "/index.html" : decoded));
  if (!file.startsWith(root + sep)) return false;
  try {
    const [realRoot, realFile] = await Promise.all([realpath(root), realpath(file)]);
    if (!realFile.startsWith(realRoot + sep)) return false;
    const details = await stat(realFile);
    if (!details.isFile()) return false;
    response.statusCode = 200;
    response.setHeader("Content-Type", MIME[extname(file)] ?? "application/octet-stream");
    response.setHeader("Content-Length", details.size);
    response.setHeader("Cache-Control", extname(file) === ".html" ? "no-cache" : file.includes(sep + "assets" + sep) ? "public, max-age=31536000, immutable" : "public, max-age=3600");
    if (method === "HEAD") response.end();
    else createReadStream(realFile).on("error", () => response.destroy()).pipe(response);
    return true;
  } catch { return false; }
}
