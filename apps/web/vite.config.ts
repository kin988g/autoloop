import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/v1": {
        target: "http://127.0.0.1:3350",
        changeOrigin: true,
        timeout: 0,
        proxyTimeout: 0,
        configure: (proxy) => {
          const server = proxy as unknown as {
            on: (
              event: "proxyRes",
              listener: (proxyRes: { headers: Record<string, string | string[] | undefined> }) => void,
            ) => void;
          };
          server.on("proxyRes", (proxyRes) => {
            const contentType = proxyRes.headers["content-type"];
            if (typeof contentType === "string" && contentType.includes("text/event-stream")) {
              proxyRes.headers["cache-control"] = "no-cache";
              proxyRes.headers["connection"] = "keep-alive";
              proxyRes.headers["x-accel-buffering"] = "no";
            }
          });
        },
      },
      "/healthz": {
        target: "http://127.0.0.1:3350",
        changeOrigin: true,
      },
    },
  },
});
