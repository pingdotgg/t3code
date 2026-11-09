import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    {
      name: "report-process-cwd",
      transformIndexHtml(html) {
        return html.replace(
          "</head>",
          `<meta name="vite-process-cwd" content="${process.cwd()}"></head>`,
        );
      },
    },
  ],
});
