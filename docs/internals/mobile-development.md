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

The [Uniwind patch](../../patches/uniwind@1.11.0.patch) still compiles CSS on Metro
updates so newly used classes are discovered. It skips global style invalidation
only when the generated stylesheet and theme list are unchanged. Skipping compilation
would lose new classes; invalidating every consumer for unchanged output makes an
ordinary component edit refresh the whole app. The fingerprint is recorded only
after initialization succeeds.

The [expo-notifications patch](../../patches/expo-notifications@57.0.15.patch) protects
`NotificationCenterManager`'s delegates and pending responses with a lock. React runtimes can
register and remove delegates concurrently during reloads or scene startup. Delivery snapshots
delegates under the lock and invokes them after releasing it. Pending-response replay removes
only the responses in its snapshot, preserving responses received during callbacks. Changes to
this native patch require reinstalling dependencies and rebuilding the iOS app.
