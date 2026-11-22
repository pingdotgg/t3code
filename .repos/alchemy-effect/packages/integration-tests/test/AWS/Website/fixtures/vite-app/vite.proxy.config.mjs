// Selected via `config: "vite.proxy.config.mjs"` by the local suite: the
// dev server proxies `/api/*` to a target the stack resolves from another
// resource's `Output` and hands over through the site's `env`.
const target = process.env.API_PROXY_TARGET;

export default {
  server: {
    proxy: target
      ? {
          "/api": {
            target,
            changeOrigin: true,
            rewrite: (path) => path.replace(/^\/api/, ""),
          },
        }
      : undefined,
  },
};
