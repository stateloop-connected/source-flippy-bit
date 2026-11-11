import pluginChecker from "vite-plugin-checker";
import { defineConfig } from "vite";

export default defineConfig({
    // Relative asset paths, so the build works from any sub-path
    // (for example a GitHub Pages project site).
    base: "./",
    plugins: [pluginChecker({ typescript: true, overlay: false })],
});
