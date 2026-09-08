import { createPlugin } from "../factory.ts";

const CLOUDFLARE_BUILT_IN_MODULES = [
  "cloudflare:email",
  "cloudflare:node",
  "cloudflare:sockets",
  "cloudflare:workers",
  "cloudflare:workflows",
];

export const cloudflareExternalsPlugin = createPlugin(
  "cloudflare-externals",
  () => {
    return {
      rolldown: {
        resolveId: {
          filter: { id: /^cloudflare:/ },
          handler(id) {
            if (!CLOUDFLARE_BUILT_IN_MODULES.includes(id)) {
              return;
            }

            return {
              id,
              external: true,
            };
          },
        },
      },
      vite: {
        enforce: "pre",
        configEnvironment(name) {
          if (name === "client") {
            // Some frameworks allow users to mix client and server code in the same file and then extract the server code.
            // As the dependency optimization may happen before the server code is extracted, we should exclude Cloudflare built-ins from client optimization.
            return { optimizeDeps: { exclude: CLOUDFLARE_BUILT_IN_MODULES } };
          }
          return {
            resolve: {
              builtins: CLOUDFLARE_BUILT_IN_MODULES,
            },
            optimizeDeps: {
              exclude: CLOUDFLARE_BUILT_IN_MODULES,
            },
          };
        },
      },
    };
  },
);
