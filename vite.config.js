import { defineConfig } from "vite";
import webExtension from "vite-plugin-web-extension";

export default defineConfig({
  base: "./",
  plugins: [
    webExtension({
      manifest: "./manifest.json",
    }),
  ],
});
