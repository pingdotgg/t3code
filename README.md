# T3 Mobile

An Android interface for coding agents running on your phone through Termux.
This fork reuses T3 Code's mobile presentation components, selectable Markdown, diff rendering, typography, palettes
and Android Ghostty terminal renderer. It replaces T3's server and client runtime with
our own local backend. Codex is the first integrated agent. This is an experimental first build; physical
Android/Termux validation is still pending.

## Run the backend in Termux

Use an Android ARM64 phone with Android 10 or later and a current Termux installation.

```sh
pkg update
pkg install nodejs-lts git
npm install -g @mmmbuto/codex-cli-termux
codex login
git clone https://github.com/screen-gd/t3mobile.git
cd t3mobile/apps/runtime
npm install --workspaces=false --omit=dev
npm start
```

Node 22.18 or newer is required. The backend runs `codex app-server` as a subprocess;
there are no native Node addons, desktop SDKs or cloud relay dependencies.
If your Codex binary has another name/path, set `T3MOBILE_CODEX_BIN` before starting.
The community Termux Codex package is maintained at
[DioNanos/codex-termux](https://github.com/DioNanos/codex-termux).

The backend listens on `127.0.0.1:8787`. On first start it creates a local pairing
credential below `~/.t3mobile` with private file permissions. Follow the terminal's
instructions to copy the credential into the app. Never share it: it grants control
of Codex and its projects. `T3MOBILE_HOME` can select another data directory, and
`T3MOBILE_PORT` can select another port.

Keep project repositories in Termux's home directory, where git and executable
permissions work normally. Android shared storage can behave differently.

## Build the mobile app

On a development computer:

```sh
npm install
npm run dev:mobile
# In another terminal, with an Android emulator/device and Android SDK configured:
npm run android --workspace @t3mobile/mobile
```

A native development build is required; Expo Go does not contain the local terminal
module. For a self-contained APK, use the `preview` profile in `apps/mobile/eas.json`
with your own EAS account, or build a release locally with the Android SDK.

In the app, connect to `ws://127.0.0.1:8787` and enter the backend's pairing credential.
On an emulator connected to a backend on your development computer, use
`adb reverse tcp:8787 tcp:8787` first. Select a project by its **Termux path**, then
create a Codex session and send a prompt. Codex credentials stay in Termux.

Sessions are read-only by default. The explicit full-access setting lets Codex write
files and execute commands without OS sandboxing; command approval policy remains
`untrusted`. Android sandbox capabilities vary by Codex build. Full access is never
enabled automatically after a sandbox failure. Approval requests and agent questions
appear in the conversation. Stop interrupts the active turn.

The backend keeps conversations and diffs across restarts. A restarted backend marks
unfinished turns interrupted; it does not silently rerun them. Keep Termux running
while working. Android may stop background processes; reconnect restores stored
history but cannot guarantee that an interrupted process continued.

## Development checks

Run only the checks for the scope you changed:

```sh
npm run typecheck:runtime
npm run typecheck:mobile
npm run export:android --workspace @t3mobile/mobile
```

Backend protocol: `packages/protocol`. Backend and Codex adapter: `apps/runtime`.
Mobile interface and connection module: `apps/mobile`. Other agents are not enabled
in this first implementation.

## Attribution

T3 Code's retained UI is MIT licensed; see `LICENSE`. The Android terminal renderer
retains its upstream notices in `apps/mobile/modules/t3-terminal/THIRD_PARTY_NOTICES.md`.
Matt Pocock's installed skills and source revisions are recorded in `.agents/skills`
and `skills-lock.json`.
