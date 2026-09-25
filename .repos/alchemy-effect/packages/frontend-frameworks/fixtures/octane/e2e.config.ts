import * as Options from "@alchemy.run/cloudflare-test-tools/e2e/Options";
import * as Octane from "@alchemy.run/frontend-frameworks/octane";

const SECRET = "s3cret-from-binding";

/**
 * An OctaneJS fullstack app (SSR + server route) built through the project's
 * own `vite build`: `@octanejs/vite-plugin` produces `dist/client` +
 * `dist/server/entry.js`, and `@octanejs/adapter-cloudflare` emits the module
 * Worker entry at `dist/server/worker.js` — wrangler-free.
 *
 * Octane's intended asset routing is asset-first with SSR on miss: exact
 * files in `dist/client` are served without invoking the Worker, and every
 * miss reaches Octane SSR (`not_found_handling: "none"`).
 *
 * Dev note: Octane's dev middleware supplies no `context.platform`, so the
 * FIXTURE_SECRET binding is observable in live/preview mode only.
 */
export default Options.make({
  // The typed factory form (harness contract form 3): map the harness
  // options onto Octane options, then pin the dev port so parallel fixture
  // runs don't collide. `framework: "@alchemy.run/frontend-frameworks/octane"` (the string
  // form) works identically when no framework-specific options are needed.
  // The deploy target defaults to `@alchemy.run/frontend-frameworks/octane/cloudflare`.
  framework: (options) => {
    const base = Octane.fromHarnessOptions(options as Octane.HarnessOptions);
    return Octane.layer({
      ...base,
      dev: { port: 3112 },
    });
  },
  target: {
    cloudflare: {
      worker: {
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_compat"],
        worker: {
          name: "fixtures-octane",
        },
      },
      preview: {
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_compat"],
        bindings: { FIXTURE_SECRET: SECRET },
        assets: {
          binding: "ASSETS",
          routerConfig: {
            has_user_worker: true,
            invoke_user_worker_ahead_of_assets: false,
          },
          assetConfig: {
            html_handling: "auto-trailing-slash",
            not_found_handling: "none",
          },
        },
      },
    },
  },
});
