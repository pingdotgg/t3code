// Mirrors `@cloudflare/vite-plugin`'s `playground/sensitive-files`: a user
// `server.fs.deny` entry adds to the files the dev server refuses to serve.
export default {
  server: { fs: { deny: ["custom-sensitive-file"] } },
};
