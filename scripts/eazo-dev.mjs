import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
process.chdir(root);
if (existsSync(path.join(root, ".env"))) process.loadEnvFile(path.join(root, ".env"));

// The API stays on loopback. Vite is the only public port and proxies same-origin API calls.
const port = Number(process.env.PORT || 3000);
const apiPort = Number(process.env.MOLAN_API_PORT || 8787);
const extraOrigins = [
  process.env.MOLAN_CORS_ORIGINS || "",
  process.env.EAZO_PREVIEW_URL || "",
  `http://localhost:${port}`,
  `http://127.0.0.1:${port}`,
].filter(Boolean).join(",");
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500).unref();
}
function run(args, env) {
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: "inherit" });
  children.push(child);
  child.on("error", () => stop(1));
  child.on("exit", (code) => { if (!stopping) stop(code ?? 1); });
}
run(["--import", "tsx", "server/src/index.ts"], {
  PORT: String(apiPort), MOLAN_HOST: "127.0.0.1", MOLAN_CORS_ORIGINS: extraOrigins,
});
run(["node_modules/vite/bin/vite.js", "--host", "0.0.0.0", "--port", String(port)], {
  MOLAN_WEB_HOST: "0.0.0.0", MOLAN_WEB_PORT: String(port), MOLAN_API_PROXY: `http://127.0.0.1:${apiPort}`,
});
process.on("SIGTERM", () => stop());
process.on("SIGINT", () => stop());
