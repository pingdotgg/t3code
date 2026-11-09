// `playground/main-resolution/vite.config.ts`: a custom entry file extension.
export default {
  environments: {
    ssr: { build: { rollupOptions: { output: { entryFileNames: "[name].mjs" } } } },
  },
};
