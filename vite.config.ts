import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// @ts-expect-error node types are not needed just for this
import process from "node:process";

const host = process.env.TAURI_DEV_HOST;
// the app version (package.json), shown in the header with its release channel
const version: string = process.env.npm_package_version ?? "0.0.0";

// Tauri expects a fixed dev port and leaves rust errors visible.
export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
}));
