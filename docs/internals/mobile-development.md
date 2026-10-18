# Mobile development lifecycle

The [connection runtime's HMR boundary](../../apps/mobile/src/lib/hot-swappable-atom-runtime.ts)
keeps a stable atom runtime and replaces its Effect layer through a writable atom.
It accepts the update only after installing the new layer. Otherwise importers
retain the old behavior even though Metro reports a successful refresh.

Do not reset the shared atom registry to refresh a connection-runtime edit. Reset
removes listeners from mounted consumers that Metro has no reason to rerender.
When the registry or managed-runtime module itself changes, normal Metro propagation
disposes its old resources. This boundary does not make arbitrary module-level atom
families safe to hot-swap. Production uses an ordinary atom runtime.

[Environment supervisor scopes](../../packages/client-runtime/src/connection/registry.ts)
are children of the registry scope. The per-environment map supports targeted
shutdown, but a supervisor created after its cleanup runs would escape it. A closed
parent scope also closes late arrivals, preventing interrupted startup or runtime
replacement from leaving a WebSocket alive outside the new registry.

Uniwind compiles CSS on Metro updates so newly used classes are discovered. It
skips global style invalidation only when the generated stylesheet and theme list
are unchanged. Skipping compilation would lose new classes; invalidating every
consumer for unchanged output makes an ordinary component edit refresh the whole
app. The fingerprint is recorded only after initialization succeeds.

The [expo-notifications patch](../../patches/expo-notifications@57.0.15.patch) protects
`NotificationCenterManager`'s delegates and pending responses with a lock. React runtimes can
register and remove delegates concurrently during reloads or scene startup. Delivery snapshots
delegates under the lock and invokes them after releasing it. Pending-response replay removes
only the responses in its snapshot, preserving responses received during callbacks. Changes to
this native patch require reinstalling dependencies and rebuilding the iOS app.
The native modules under `apps/mobile/modules/` are `file:` dependencies, and pnpm
copies those into its virtual store instead of linking them. Metro bundles the copy,
so an edit to a module's TypeScript is invisible to a running dev client until
`vp i` re-syncs it, while Gradle and CocoaPods compile the worktree directory
directly. A JavaScript change that "has no effect" on device is usually this.

## React Compiler

Metro runs the compiler only because `experiments.reactCompiler` is set in `app.config.ts`. Expo
then passes `supportsReactCompiler` to `babel-preset-expo`, which owns the plugin options; there is
no `babel.config.js` entry to look for. Release bundles use `panicThreshold: "NONE"`, so a function
the compiler can't prove safe ships unmemoized with no build error.
[`reactCompilerCoverage.test.ts`](../../apps/mobile/src/reactCompilerCoverage.test.ts) runs the
same preset over every source file. It fails on a new bailout, and on a file in `KNOWN_BAILOUTS`
that now compiles, so the list only shrinks. When you fix a listed file, delete its entry and its
manual `useMemo`/`useCallback`/`memo` in the same change. Most mobile bailouts are `try` without
`catch` or with `finally`, and refs read during render; see [Web UI](web-ui.md#react-compiler)
for the usual rewrites. Mobile runs `t3code/no-manual-memo` with `allowMemoHooks`, so memo
directives are errors but the hooks stay legal until `KNOWN_BAILOUTS` is empty.
