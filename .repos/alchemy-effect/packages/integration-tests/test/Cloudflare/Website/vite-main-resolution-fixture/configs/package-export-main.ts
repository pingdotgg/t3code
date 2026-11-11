// `playground/main-resolution/vite.config.package-export-main.ts`.
export default {
  environments: {
    ssr: { optimizeDeps: { exclude: ["@playground/main-resolution-package"] } },
  },
};
