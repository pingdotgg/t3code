import * as Options from "@alchemy.run/cloudflare-test-tools/e2e/Options";

/**
 * The Vite project root is `app/`, NOT the fixture root. That is the point of
 * this fixture: `app/src/server.ts` imports `../../lib/src/greeting.ts`, a
 * module that lives OUTSIDE the project root in a sibling directory with its
 * own `package.json` — the shape of a monorepo workspace member importing a
 * sibling package by path. The build-output collector must classify `lib/` as
 * an external workspace (`dist/build.json` → `externalWorkspaces`).
 *
 * `root` is the harness's first-class project-root option: the CLI/Server
 * thread it into `Framework.build`/`Framework.dev`, while the harness's own
 * persistence (`dist/build.json`) stays anchored at the fixture root. This
 * fixture deliberately uses the built-in Vite framework path (no framework
 * package) to isolate the workspace machinery from framework churn.
 */
export default Options.make({
  root: "./app",
  target: {
    cloudflare: {
      worker: {
        // Worker entry, relative to the Vite root (app/).
        main: "./src/server.ts",
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_compat"],
        worker: {
          name: "fixtures-monorepo-workspace",
          bindings: [],
        },
      },
      preview: {
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_compat"],
      },
    },
  },
});
