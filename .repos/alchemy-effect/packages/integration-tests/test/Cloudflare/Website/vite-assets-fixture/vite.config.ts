// No client entry: mirrors `@cloudflare/vite-plugin`'s
// `playground/assets/vite.config.no-client-entry.ts`.
export default {
  environments: {
    ssr: { build: { assetsInlineLimit: 0 } },
  },
};
