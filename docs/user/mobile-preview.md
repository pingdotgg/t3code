# Mobile dev server preview

T3 Code Mobile can open a dev server running on your environment's machine — a Vite app on
`localhost:5173`, a Next.js app on `localhost:3000` — without exposing it to the internet. The page
loads through your existing T3 connection, whether that is your local network, Tailscale, or
T3 Connect. The dev server stays bound to the machine it runs on and never needs a public URL.

To open a preview:

1. Open a thread on the environment running the dev server.
2. Tap the **preview** button in the thread header.
3. Pick a dev server from the list. Servers started in thread terminals are discovered
   automatically.

The page renders live: root-relative assets, API calls, and hot reload all work. Use the toolbar to
go back, reload, capture a screenshot, or close the preview.

## Annotate and send to the agent

1. Tap **Capture** to snapshot the current viewport.
2. Tap to drop numbered pins, or switch to **Box** and drag to outline an area.
3. Write a note for each marker.
4. Tap **Add to chat**.

The flattened screenshot and your numbered notes are added to the message draft. Nothing sends
until you do — edit the message, remove the attachment, or add more images first. **Cancel**
discards the annotation and leaves your draft unchanged.

## Notes and limits

- One preview is open at a time. Opening another dev server replaces the current preview session.
- Preview access uses a short-lived ticket from the connected environment and works only for that
  environment's own localhost servers.
- Agent browser automation is unaffected: agents keep driving the preview browser on the host
  machine, not on your phone.
