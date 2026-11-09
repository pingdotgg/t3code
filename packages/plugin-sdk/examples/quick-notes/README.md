# Quick notes

Short notes kept by the plugin's server half, so every device connected to the environment sees
the same list. Open the **Quick notes** right panel in a thread to add and remove notes.

First build its web half with `vp run build:examples` in `packages/plugin-sdk`. Then install it
by dragging this folder onto **Settings → Plugins**, or with **Add plugin → Choose folder**.

It uses `rightPanel.register`, `rpc.invoke`, `rpc.subscribe` and an atom on the web side, and
`rpc.register`, `rpc.publish` and `storage` on the server side. Both halves check their calls
against the `QuickNotesRpc` type in `rpc.ts`.
