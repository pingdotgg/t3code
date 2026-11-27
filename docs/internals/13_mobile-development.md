# Mobile development lifecycle

## Hot reload and native module traps

- **HMR boundary.** The [connection runtime HMR wrapper](../../apps/mobile/src/lib/hot-swappable-atom-runtime.ts)
  swaps the Effect layer through a writable atom rather than resetting the shared atom registry;
  resetting the registry drops listeners on mounted consumers that Metro will not rerender.
- **Registry-scoped supervisors.** Environment supervisor scopes are children of the registry scope
  so interrupted startup or runtime replacement closes late arrivals instead of leaking sockets.
- **Native module `file:` copies.** Modules under `apps/mobile/modules/` are `file:` dependencies
  that pnpm copies into its virtual store. Gradle and CocoaPods compile the worktree directly, but
  Metro bundles the pnpm copy—run `vp i` after editing a local module's TypeScript or changes will
  not appear on device.

## React Compiler

Expo enables the compiler through `experiments.reactCompiler` in `app.config.ts` (not
`babel.config.js`), and release builds ship unmemoized bailouts silently (`panicThreshold: "NONE"`).
[`reactCompilerCoverage.test.ts`](../../apps/mobile/src/reactCompilerCoverage.test.ts) enforces
compilation across source files and fails on new bailouts or stale entries in `KNOWN_BAILOUTS`. When
fixing a listed file, remove its entry and manual `useMemo`/`useCallback`/`memo` in the same change
(see [Web UI](./10_web-ui.md#react-compiler) for common rewrites).
