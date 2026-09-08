# @alchemy.run/frontend-frameworks/solidstart

Adapter-free SolidStart integration: programmatic build and dev for SolidStart
projects, with the deploy platform passed in as a **deploy target** value. AWS
Lambda is the built-in target (`@alchemy.run/frontend-frameworks/solidstart/aws`);
the framework half of this package contains no AWS code at all.

## Architecture: framework half × target half

| Module                                                                                    | Role                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@alchemy.run/frontend-frameworks/solidstart` (`SolidStart.ts`, `index.ts`, `UserConfig.ts`) | **Framework half.** Drives the PROJECT's own Vite install (`createBuilder(...).buildApp()` for build, `createServer()` for dev), appends the SolidStart nitro plugin carrying the target's preset, and maps nitro's `.output` onto framework-core's `BuildOutput`. Target-agnostic — zero AWS imports. |
| `@alchemy.run/frontend-frameworks/solidstart/aws` (`aws.ts`)                                 | **Target half.** The AWS Lambda `SolidStartTarget`: nitro's `aws-lambda` preset, `awsLambda.streaming`, the Node bundle settings, and the wholesale `build` hook that runs the build in a disposable child process.                                                                                    |

Background on why the integration is shaped this way:

- **SolidStart 2 is expressed entirely as Vite plugins.** `solidStart()` from
  `@solidjs/start/config` declares the `client` and `ssr` environments and a
  `builder.buildApp` that builds both; `@solidjs/vite-plugin-nitro-2` declares
  a second `buildApp` that additionally runs nitro over the emitted SSR
  bundle. There is no adapter file and no framework CLI to drive.
- **`vite.build()` is not enough.** Vite's legacy `build()` builds one
  environment, so it would silently produce the client bundle and no server.
  The integration uses `createBuilder(...).buildApp()`, the path `vite build`
  itself takes.
- **The deploy target owns the nitro preset, and the plugin is the only seam.**
  `nitroV2Plugin` always passes a `preset` down to nitro (its own default is
  `node-server`), so neither `NITRO_PRESET` nor a `nitro.config.ts` can
  override it. The integration therefore constructs the plugin itself and
  appends it through vite's inline config: inline plugins are concatenated
  after the config file's, and vite merges plugin `config()` results in order,
  so the appended instance's `buildApp` gets the last word. A project that
  registers `nitroV2Plugin` in its own vite config would have its nitro
  options silently dropped, so that **fails the build with an actionable
  error** (`hasForeignNitroPlugin` / `pluginConflictMessage`) — nitro options
  belong on the integration's `nitro` option, which forwards them.
- **The `aws-lambda` output needs no finishing pass.** Nitro emits
  `.output/server/index.mjs` exporting a `handler`, its own
  `package.json` (`type: "module"`), and copied externals under
  `.output/server/node_modules` — a complete Node deployment unit. Client
  assets and prerendered pages land in `.output/public`.
- **Builds run in a child process.** `solidStart()` scans the route directory
  from `process.cwd()` at config-load time and user plugins may mutate the
  process, so the AWS target's wholesale `build` spawns
  `core/BuildChildRunner` with `cwd = <project root>`.
- **Dev aligns the cwd instead.** The dev server runs in the caller's process
  (alchemy's dev sidecar), so `inProjectCwd` sets the cwd across the window in
  which vite evaluates the config module and restores it immediately after.
  Consequence, upstream and unavoidable while the plugin keys off the cwd: one
  process hosts the dev server of one SolidStart project at a time.
- **No Cloudflare target.** Cloudflare deploys SolidStart through its native
  Vite integration (`Cloudflare.Website.Vite`) with no nitro step at all.
