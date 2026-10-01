# Typed Files authoring example

This source version of the read-only Files provider uses `defineExtension`, the public catalogue descriptors, and typed API bindings. It keeps the same package identity (`example.files`), presentation and info APIs, project grants, restore state, and portable tree/text experience as `examples/installable-files`, while keeping the server entry separately typed.

Build it from a project created with the SDK CLI. The example intentionally covers read-only file browsing, accumulated pagination, parent navigation, refresh, cancellation, visibility restoration, stale-result suppression, and truncated/error states; editing and native Files parity are outside its scope.
