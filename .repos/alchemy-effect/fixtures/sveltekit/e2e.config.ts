import { KvNamespace, Text } from "@alchemy.run/cloudflare-runtime/core/bindings";
import * as Options from "@alchemy.run/cloudflare-test-tools/e2e/Options";
import * as SvelteKit from "@alchemy.run/frontend-frameworks/sveltekit";

const SECRET = "s3cret-from-binding";
// FIXTURE_OVERRIDE exists as a real Text binding ("proxied-value") AND as a
// framework-level `dev.env` literal ("literal-override"): in dev the literal
// must win over the value served through the platform proxy (back-compat with
// the phase-1 stub platform); live serves the binding value.
const OVERRIDE_BINDING_VALUE = "proxied-value";
const OVERRIDE_LITERAL_VALUE = "literal-override";

export default Options.make({
  // The typed factory form (harness contract form 3): map the harness
  // options onto SvelteKit options, then pin the dev port so parallel fixture
  // runs don't collide. `framework: "@alchemy.run/frontend-frameworks/sveltekit"` (the string
  // form) works identically when no framework-specific options are needed.
  // The deploy target defaults to `@alchemy.run/frontend-frameworks/sveltekit/cloudflare`.
  framework: (options) => {
    const base = SvelteKit.fromHarnessOptions(options as SvelteKit.HarnessOptions);
    return SvelteKit.layer({
      ...base,
      dev: { ...base.dev, port: 3103, env: { FIXTURE_OVERRIDE: OVERRIDE_LITERAL_VALUE } },
    });
  },
  // Target-scoped config carriage: `target.cloudflare.worker` is what the
  // framework package reads (compat date/flags, bindings, assets behavior);
  // `target.cloudflare.preview` configures the miniflare preview server the
  // harness's cloudflare target serves built output with.
  target: {
    cloudflare: {
      worker: {
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_compat"],
        worker: {
          name: "fixtures-sveltekit",
          bindings: [
            Text.local("FIXTURE_SECRET", SECRET),
            Text.local("FIXTURE_OVERRIDE", OVERRIDE_BINDING_VALUE),
            // a real (non-literal) resource binding: served in dev through
            // cloudflare-runtime's platform proxy
            KvNamespace.local({ binding: "FIXTURE_KV" }),
          ],
          assets: {
            htmlHandling: "auto-trailing-slash",
            notFoundHandling: "none",
            runWorkerFirst: false,
          },
        },
      },
      preview: {
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_compat"],
        bindings: { FIXTURE_SECRET: SECRET, FIXTURE_OVERRIDE: OVERRIDE_BINDING_VALUE },
        kvNamespaces: ["FIXTURE_KV"],
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
