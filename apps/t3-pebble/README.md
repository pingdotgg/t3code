# T3 Code for Pebble Time 2

Browse threads, dictate replies, and hear responses on your watch. Threads are grouped into project sections in recency order; rows show the machine, project directory, harness, and last update. Tap to select, drag or use the up/down buttons to scroll, and swipe right to go back. Completed activity is grouped into one counted summary row that stays collapsed until tapped. At the bottom of a chat, tap the mic to dictate; away from the bottom, the same control scrolls to the latest activity.

## Install

This is a **development build**, not yet a one-tap app-store install. It currently needs a Mac running T3 Code, a Pebble Time 2 paired with Android, and Tailscale on both devices. The Mac needs Bun, the Pebble SDK 4.44 or newer, and the Tailscale CLI. Enable Dev Connection in the Pebble phone app and note its phone IP address.

From this directory, run:

```sh
./install.sh PHONE_IP
```

The installer builds and installs the watch app and starts its companion on the Mac. Keep T3 Code and the companion running; the installer configures the companion to start at login.

In the Pebble phone app, open **T3 Code → Settings**. Paste the full pairing URL from T3 Code's **Settings → Sharing & access**, then save your ElevenLabs API key. You can update either one there later. The key is stored on the Mac.

For alerts when the watch app is closed, enable device notifications in T3 Code through T3 Connect and allow the Pebble phone app to forward them. See [mobile notifications](../../docs/user/mobile-notifications.md).

## Remove

To remove the Mac companion, run:

```sh
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/codes.t3.pebble-companion.plist
rm ~/Library/LaunchAgents/codes.t3.pebble-companion.plist
```

Remove T3 Code from the Pebble app on your phone. The ignored `.mcp-token`, `.pebble-token`, `.eleven-key`, and `.tls` files in this directory contain the companion's credentials; delete them if you no longer need the app.

## Development

Run `bun test bridge service` to test the companion. `./install.sh PHONE_IP` rebuilds the watch app as part of installation. Use `pebble install --emulator emery` to run without a physical watch and `pebble screenshot --emulator emery --no-open SCREENSHOT.png` to capture its screen. The generated watch bundle contains a private companion credential, so don't share it.

The provider logos in `resources/images/providers/` are rendered from the same SVG sources the web app uses; regenerate them with `NODE_PATH=../../scripts/node_modules bun scripts/generate-provider-icons.ts`.
