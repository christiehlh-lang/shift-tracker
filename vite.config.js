import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base must match the repo name for GitHub Pages project sites:
// https://christiehlh-lang.github.io/shift-tracker/
export default defineConfig({
  base: "/shift-tracker/",
  plugins: [react()],
});
