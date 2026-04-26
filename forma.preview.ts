import { defineFormaPreviewConfig } from "@forma/preview-react";

export default defineFormaPreviewConfig({
  appRoot: "apps/web",
  server: {
    command: ["bun", "run", "dev"],
    cwd: "apps/web",
  },
  scan: {
    include: ["src/**/*.preview.tsx"],
  },
});
