// Runs the full Playwright suite: live (miniflare over dist/build.json) and
// dev (Nuxt's own dev server with `event.context.cloudflare` served through
// the platform-proxy bridge, wrangler-free).
import { execSync } from "node:child_process";

// `bun run` puts the fixture's node_modules/.bin on PATH for playwright.
execSync("bun run test:e2e", { stdio: "inherit" });
