import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Default: bind Vite to loopback so LAN cannot hit /api proxy → API.
 * Override with MOLAN_WEB_HOST=0.0.0.0 when you intentionally need LAN preview.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const host = (env.MOLAN_WEB_HOST || process.env.MOLAN_WEB_HOST || "127.0.0.1").trim() || "127.0.0.1";
  return {
    plugins: [react()],
    server: {
      host,
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": {
          target: "http://127.0.0.1:8787",
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
      port: 4173,
      strictPort: true,
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
    },
  };
});
