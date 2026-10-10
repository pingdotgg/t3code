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

Reanimated's `DISABLE_COMMIT_PAUSING_MECHANISM` in `apps/mobile/package.json` is for
keyboard-controller: the composers' `KeyboardStickyView` and the `KeyboardChatScrollView` that
LegendList's `KeyboardAwareLegendList` renders for the thread feed. With commit pausing on, React
commits hold back their keyboard updates, so opening the keyboard while a turn streams makes the
composer jump instead of moving with the keyboard. The flag is safe only with React Native's
`preventShadowTreeCommitExhaustion`: otherwise any running animation commits every frame, and a
React commit slower than a frame is retried until the app stops responding. The prebuilt React
Native core leaves that flag off, so
[t3-react-native-flags](../../apps/mobile/modules/t3-react-native-flags) force-overrides it at
launch on top of the stable release level. Setting a React Native release level means changing
that module's base provider too. Remove the module together with the Reanimated flag.
