// Mirrors `@cloudflare/vite-plugin`'s `playground/static-mpa/vite.config.ts`.
export default {
  environments: {
    client: {
      build: {
        rollupOptions: {
          input: {
            main: "index.html",
            contact: "contact.html",
            "404": "404.html",
            about: "about/index.html",
            "about-404": "about/404.html",
          },
        },
      },
    },
  },
};
