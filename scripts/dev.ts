import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const children = [
  spawn(process.execPath, ["--import", "tsx", "--watch", "server/index.ts"], { cwd: root, stdio: "inherit" }),
  spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--config", "client/vite.config.ts", "client"], { cwd: root, stdio: "inherit" }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = code;
}
for (const child of children) {
  child.on("error", error => { console.error(error.message); stop(1); });
  child.on("exit", code => stop(code ?? 0));
}
process.once("SIGINT", () => stop());
process.once("SIGTERM", () => stop());
