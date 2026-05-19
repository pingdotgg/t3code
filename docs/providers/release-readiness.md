# Hermes and Pi release readiness

Use this checklist before publishing a fork build with Hermes or Pi provider support.

## Provider setup

- Open **Settings -> Providers** and expand Hermes and Pi.
- Confirm each provider shows a complete setup checklist.
- Use **Copy diagnostics** if the provider is unavailable, then verify the reported binary paths in a terminal.
- Use **Update provider** when an update is offered, then refresh provider status.
- Open a fresh chat, select the provider from the model picker, and send a small prompt.

## Mac validation

- Build the Apple Silicon DMG:

```sh
bun run dist:desktop:dmg:arm64
```

- Mount the DMG and confirm `T3 Code (Alpha).app` appears.
- Install from the DMG on a clean macOS user account.
- Confirm Hermes and Pi are detected when installed under common paths such as `~/.local/bin`.
- Confirm absolute binary paths work when the packaged app cannot see the shell `PATH`.

## Windows validation

- Build the Windows installer:

```sh
bun run dist:desktop:win:x64
```

- Install the generated `.exe` on Windows.
- Confirm Hermes detection through `where hermes`.
- Confirm Pi detection through `where pi-acp` and `where pi`.
- Confirm `.cmd` paths under `%APPDATA%\npm` work from the packaged app.

## Screenshots

Capture fresh-chat screenshots after provider selection:

- Hermes selected with the Hermes chat background visible.
- Pi selected with the Pi chat background visible.
- Settings -> Providers with the setup checklist and update action visible.

Store screenshots under `docs/assets/` and keep the README image links current.
