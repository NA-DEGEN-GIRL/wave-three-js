import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, "src/lib/index.js"),
      name: "WaterPro",
      formats: ["es", "umd"],
      fileName: (format) => format === "es" ? "water-pro.js" : "water-pro.umd.cjs",
    },
    rollupOptions: {
      external: ["three", "three/webgpu", "three/tsl", "three/addons/tsl/display/BloomNode.js"],
      output: {
        globals: {
          three: "THREE",
          "three/webgpu": "THREE",
          "three/tsl": "THREE.TSL",
        },
      },
    },
    sourcemap: true,
    minify: false, // keep readable for source maps / debugging
  },
});
