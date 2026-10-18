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

## Measuring renders

[`render-counter.ts`](../../apps/mobile/src/features/development/render-counter.ts) counts the
components React rendered in each commit and why: a changed state slot, changed props, or
context. It wraps the DevTools hook from the first import in `index.ts` and loads only when
`__DEV__` and `EXPO_PUBLIC_T3_RENDER_COUNTER=1`, so release bundles never contain it. The walk
skips subtrees React bailed out of. A probe that checks `flags & 1` on every fiber reports
renders that never happened, because bailed-out fibers keep flags from older commits.

[`measure-renders.mts`](../../apps/mobile/scripts/measure-renders.mts) drives a measurement from
outside the app. It evaluates the counter's globals through Metro's Hermes inspector proxy, which
works the same for iOS simulators and Android emulators and needs no taps, `simctl`, or `adb`. It
starts a real provider turn through the server, opens the thread with an app link, records a window
mid-stream, and prints the median renders, commits, top components and top causes. Expo drops inspector sockets whose `Origin` is not the URL Metro advertises, so
pass that URL (the LAN address with `--lan`) as `--metro`.

```bash
EXPO_PUBLIC_T3_RENDER_COUNTER=1 vp run dev:client   # in apps/mobile, then pair the app
node apps/server/src/bin.ts auth session issue --base-dir <base-dir> --token-only
node apps/mobile/scripts/measure-renders.mts --server <server-origin> --token <token> \
  --metro http://<metro-lan-host>:8081 --project-root <scratch-dir>
```

`--route /settings/usage` instead reloads the app, opens that path from Home and records a 6 s window over
mount and data settling, with no provider turn and no `--server`, `--token` or `--project-root`.
With `--server` as well, the app reloads, opens that path (`/` stays on Home) and the reply streams in a
new thread the app never shows, which measures what streaming elsewhere costs the screen in front.

Compare before and after on the same base, on the same device, with the median of three runs.
Provider output varies run to run, so a single run or a comparison across bases is noise.

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
`t3code/no-hookless-use-function` rejects a `use*` function that calls no hook, since the compiler
leaves it uncached. A platform stub of a real hook, such as an `.android.ts` file, keeps the hook
name and suppresses the rule with a reason.
