// A client entry that isn't `index.html`: mirrors
// `playground/assets/vite.config.ts`.
export default {
  environments: {
    client: { build: { rollupOptions: { input: "html-page.html" } } },
    ssr: { build: { assetsInlineLimit: 0 } },
  },
};
