# Native Diff extension

`createDiffExtension(useBindings)` registers `t3.diff/view` using the public extension SDK. Supply a React context hook returning `DiffBindings`; register the factory once, then mount through `ExtensionSurface` under the existing application providers. The factory does not call the hook until React renders the view.

This is a **trusted bundled native bridge**, not an external-package sandbox or RPC interface. It intentionally imports the existing DiffPanel domain component. DiffPanel retains query, selection, source-navigation, annotation and comparison behavior; the host retains routing, resource identity, workspace-mutation notifications, composer authority and checkpoint execution. No repository-write capability is introduced.

Set `panelKey` to the active-thread key so a thread switch resets the panel's local state. Keep the supplied composer target, active route and SDK thread context synchronized; the existing domain component resolves its thread from the router, not the SDK snapshot. Do not keep a background thread's renderer mounted under another thread's route.

The extension owns embedded mode, lazy loading and the null Suspense fallback. Empty, loading and failure states remain in the composed domain panel. Restoration accepts only `null`; the native host stores selection and layout separately. Web and desktop are declared; React Native is not supported by this renderer.

Hide/show retains local React state and existing DiffPanel observers. Close/unregister unmounts presentation without disposing shared domain resources. Integrated hosts must explicitly evaluate hidden-view refresh cost and preserve route/context isolation; registration alone does not prove shell parity.

`native.test.tsx` runs the same observable journeys against direct built-in composition and the registered renderer through the real SDK React adapter. The real DiffPanel, parser, selection/navigation stores and mutation-refresh hook run with fixture query hooks and stand-in UI controls/code viewport. These are focused behavioral tests, not browser, Electron, remote connection or compositor-performance proof.
