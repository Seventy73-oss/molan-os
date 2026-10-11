import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Default: bind Vite to loopback so LAN cannot hit /api proxy → API.
 * Override with MOLAN_WEB_HOST=0.0.0.0 when you intentionally need LAN preview.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const host = (env.MOLAN_WEB_HOST || process.env.MOLAN_WEB_HOST || "127.0.0.1").trim() || "127.0.0.1";
  const apiProxy =
    (env.MOLAN_API_PROXY || process.env.MOLAN_API_PROXY || "http://127.0.0.1:8787").trim() ||
    "http://127.0.0.1:8787";
  const webPort = Number(env.MOLAN_WEB_PORT || process.env.MOLAN_WEB_PORT || 5173) || 5173;
  return {
    plugins: [react()],
    // SDK checks `typeof process` before its dynamic env lookup. Replacing only
    // process.env works in Vite dev but leaves that guard false in production.
    // Supply a minimal public object, never loadEnv() or the real Node process.
    define: {
      "process": "{}",
      "process.env": JSON.stringify({ NODE_ENV: mode, EAZO_APP_ID: env.EAZO_APP_ID || process.env.EAZO_APP_ID || "" }),
    },
    server: {
      host,
      port: webPort,
      strictPort: true,
      allowedHosts: (env.EAZO_PREVIEW_URL || process.env.EAZO_PREVIEW_URL)
        ? [new URL(env.EAZO_PREVIEW_URL || process.env.EAZO_PREVIEW_URL!).hostname]
        : [],
      proxy: {
        "/api": {
          target: apiProxy,
          changeOrigin: false,
          // Only proxy when the request arrives on loopback unless explicitly opened.
          bypass(req) {
            if (host === "127.0.0.1" || host === "localhost") return undefined;
            const remote = req.socket?.remoteAddress || "";
            const local =
              remote === "127.0.0.1" ||
              remote === "::1" ||
              remote === "::ffff:127.0.0.1" ||
              remote === "";
            if (!local && (process.env.MOLAN_WEB_HOST || "").trim() !== "0.0.0.0") {
              return "/index.html";
            }
            return undefined;
          },
        },
      },
    },
    preview: {
      host,
      port: Number(env.MOLAN_WEB_PREVIEW_PORT || process.env.MOLAN_WEB_PREVIEW_PORT || 4173) || 4173,
      strictPort: true,
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
    },
  };
});
