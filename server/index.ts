import { createChatServer } from "./app.js";

const port = Number(process.env.PORT ?? "8080");
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be an integer from 0 to 65535.");
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",").map(origin => origin.trim()).filter(Boolean);
const application = createChatServer({
  dataFile: process.env.DATA_FILE ?? "data/coderoom.sqlite",
  ...(process.env.ADMIN_PASSWORD !== undefined ? { adminPassword: process.env.ADMIN_PASSWORD } : {}),
  ...(allowedOrigins ? { allowedOrigins } : {}),
  ...(process.env.STATIC_DIR ? { staticDir: process.env.STATIC_DIR } : {}),
});
const address = await application.listen(port, process.env.HOST ?? "0.0.0.0");
console.log(`CodeRoom listening on port ${address.port}`);
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void application.close().then(() => process.exit(0), () => { console.error("CodeRoom could not complete durable storage shutdown."); process.exit(1); });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
