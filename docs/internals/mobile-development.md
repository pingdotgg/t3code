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

Environment supervisor scopes are children of the connection registry scope.
The registry's per-environment map supports targeted shutdown, but it cannot be
the sole owner: a supervisor created after that map's finalizer has run must
still inherit the closed parent scope. Otherwise interrupted startup or runtime
replacement can leave a session and WebSocket alive outside the current registry.

The compact Home list owns its minute-based presentation clock in a focus effect.
Blur clears the interval without a render-driving focus subscription; focus
refreshes the clock immediately. Other prop or state changes can still render
the hidden list. Exact snooze-expiry timers remain active, and the visible iPad
sidebar keeps its own minute updates.

Connection and runtime projections are shared per environment. Thread selection
consumers should read those atoms instead of repeatedly parsing the same socket
URL or constructing new connection objects during each render.

The Uniwind dependency patch still recompiles CSS on Metro updates so newly used
classes are discovered. It fingerprints the generated native stylesheet and
theme list, then skips development-only global invalidation when that output is
unchanged. A changed stylesheet or theme list still resets the style caches and
notifies subscribers. The digest is committed only after initialization succeeds.
Web and production retain their existing initialization behavior.

After installing or changing the Uniwind patch, restart Metro once with
`vp run dev:client:reset` from `apps/mobile`. pnpm gives patched packages new
filesystem paths, and cached transforms can otherwise retain references to the
previous package. Ordinary development starts should retain the transform cache.

The expo-notifications patch protects `NotificationCenterManager`'s delegate and pending-response
arrays with a lock. React runtimes can register and remove delegates concurrently during reloads
or native scene startup. Delivery takes a snapshot under the lock and invokes delegates after
releasing it, allowing callbacks to register other delegates. Pending-response replay removes
only the responses it saw so a response arriving during a callback remains available.

Changes to this native patch require a fresh dependency install, CocoaPods refresh, and an iOS
rebuild. `vp test run apps/mobile/scripts/notification-center-manager.test.ts` compiles the
installed dependency with a small native harness on macOS and runs concurrent registration and
delivery checks under ThreadSanitizer without launching a simulator.
