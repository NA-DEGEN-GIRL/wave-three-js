import { defineConfig } from "vite";

// Conditional base path:
//   - dev (`vite`)     → '/'             so localhost:5173 works as-is
//   - build (`vite build`) → '/wave-three-js/'  for GitHub Pages project URL
//     (https://NA-DEGEN-GIRL.github.io/wave-three-js/)
//
// If you fork / rename the repo, change the base string to match the new
// repo name -- otherwise the deployed bundle will 404 on its own assets.
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/wave-three-js/" : "/",
  server: { host: "0.0.0.0", port: 5173, strictPort: true, allowedHosts: true },
  preview: { host: "0.0.0.0", port: 4173, strictPort: true, allowedHosts: true },
}));
