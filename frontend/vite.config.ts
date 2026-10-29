import { defineConfig } from "vite";
export default defineConfig({
  base: "./",
  build: {
    target: "es2020",
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom"],
          editor: [
            "@codemirror/state",
            "@codemirror/view",
            "@codemirror/lang-sql",
            "@codemirror/commands",
            "@codemirror/autocomplete",
            "@codemirror/language",
          ],
          formatter: ["sql-formatter"],
        },
      },
    },
  },
});
