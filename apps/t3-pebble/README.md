# T3 Code for Pebble Time 2

Browse threads, dictate replies, and hear responses on your watch. Threads are grouped into project sections in recency order; rows show the machine, project directory, harness, and last update. Tap to select, drag or use the up/down buttons to scroll, and swipe right to go back. Completed activity is grouped into one counted summary row that stays collapsed until tapped. At the bottom of a chat, tap the mic to dictate; away from the bottom, the same control scrolls to the latest activity.

The watch app talks to your T3 Code server directly from PebbleKit JS on the phone. There is no Mac companion, helper service, or second token: the phone holds the MCP access token and your optional ElevenLabs key in its own local storage.

## Install

This is a **development build**, not yet a one-tap app-store install. It needs T3 Code running on a reachable machine and a Pebble Time 2 paired with Android. Enable Dev Connection in the Pebble phone app and note its phone IP address.

From this directory, run:

```sh
./install.sh PHONE_IP
```

Then, in the Pebble phone app, open **T3 Code → Settings**. Paste the full pairing URL from T3 Code's **Settings → Sharing & access** and save. The watch shows a notification when pairing succeeds or fails. Optionally add an ElevenLabs API key on the same page to have new replies read aloud. You can reopen Settings later to update either value; leaving the pairing URL unchanged keeps the current connection.

The pairing URL is exchanged for an MCP token with PKCE, and only the server origin, token, and ElevenLabs key are stored, on the phone only. Nothing secret is written into `package.json` or the built bundle, so the generated watch app can be shared.

## Lifecycle

PebbleKit JS runs only while the watch app is open. Thread polling and speech stop when the watch app exits, and there is no background companion to forward notifications. The watch refreshes every five seconds while a thread is on screen.

## Development

Run `vp test run apps/t3-pebble/bridge` from the repository root to test the watch app's request, pairing, and UI helpers. `pebble build` builds the watch app; `./install.sh PHONE_IP` also installs it. Use `pebble install --emulator emery` to run without a physical watch and `pebble screenshot --emulator emery --no-open SCREENSHOT.png` to capture its screen.

Direct requests to your T3 server and to `api.elevenlabs.io` come from the phone's WebView, so the server must allow cross-origin MCP requests from the Pebble app. Verify pairing and speech on a real phone before relying on them.

The provider logos in `resources/images/providers/` are rendered from the same SVG sources the web app uses; regenerate them with `NODE_PATH=../../scripts/node_modules bun scripts/generate-provider-icons.ts`.
