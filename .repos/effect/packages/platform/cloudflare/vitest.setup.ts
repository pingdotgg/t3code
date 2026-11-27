import { createRequire } from "node:module"

if (process.versions.bun !== undefined) {
  const require = createRequire(import.meta.url)
  const miniflareRequire = createRequire(require.resolve("miniflare"))

  // Bun's built-in Undici shim lacks the dispatcher methods Miniflare needs
  // when restarting workerd. Load Miniflare's installed Undici implementation.
  // https://github.com/oven-sh/bun/issues/39247
  const undici = miniflareRequire(miniflareRequire.resolve("undici/index.js"))
  Object.assign(require("undici"), undici)
}
