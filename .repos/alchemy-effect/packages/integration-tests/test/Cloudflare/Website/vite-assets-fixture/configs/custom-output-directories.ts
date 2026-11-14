// Mirrors `playground/spa-with-api/vite.config.custom-output-directories.ts`.
export default {
  build: { outDir: "custom-root-output-directory" },
  environments: {
    client: { build: { outDir: "custom-client-output-directory" } },
    ssr: { build: { assetsInlineLimit: 0 } },
  },
};
