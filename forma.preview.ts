import { defineFormaPreviewConfig } from "@forma/preview-react";

export default defineFormaPreviewConfig({
  appRoot: "apps/web",
  framework: "react",
  bundler: "vite",
  server: {
    command: ["bun", "run", "dev"],
    cwd: "apps/web",
  },
  scan: {
    include: ["src/**/*.preview.tsx"],
  },
  components: {
    include: ["src/**/*.{tsx,jsx}"],
  },
  graph: {
    include: ["src/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs,css,scss,sass,less}"],
    exclude: ["**/*.test.*", "**/*.spec.*", "**/*.stories.*", "**/*.story.*"],
  },
});
