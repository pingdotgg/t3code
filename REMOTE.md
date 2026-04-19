# Connecting to a Workbench server

Use this when you want to connect the Workbench desktop app to a server running on another machine — for example, a beefier Mac at home from your laptop on the go, or a shared workstation reachable from your phone.

## Recommended setup

Use a trusted private network that meshes your devices together — Tailscale, ZeroTier, or any other mesh VPN.

That gives you:

- a stable address to connect to
- transport security at the network layer
- no need to expose anything to the public internet

## Two ways to enable network access

### Option 1: From the desktop app

If you're already running the desktop app and want to make it reachable from other devices:

1. Open **Settings → Connections**.
2. Under **Manage Local Backend**, toggle **Network access** on. The app restarts and binds the backend to all network interfaces.
3. The settings panel shows the address (e.g. `http://192.168.1.42:3773`).
4. Hit **Create Link** to generate a one-time pairing link to share with another device.

### Option 2: Headless server (CLI)

For running on a machine without a GUI — say, an SSH'd-into Mac mini.

```bash
npx workbench serve --host "$(tailscale ip -4)"
```

`workbench serve` starts the server without opening a browser and prints:

- a connection string
- a pairing token
- a pairing URL
- a QR code for the pairing URL

From another device, you can:

- scan the QR code on your phone
- paste the full pairing URL into the desktop app
- enter the host and token separately in the desktop app

`workbench serve --help` has the full flag reference. Same general startup options as the local backend, including an optional `cwd`.

> **Note:** Adding new projects on a remote environment via the GUI isn't fully supported yet. For now, use `workbench project ...` on the server machine to add projects, then connect from the GUI.

## How pairing works

The remote device doesn't need a long-lived secret up front. Instead:

1. `workbench serve` (or **Create Link** in the desktop app) issues a one-time owner pairing token.
2. The remote device exchanges that token with the server.
3. The server creates an authenticated session for that device.

After pairing, future access is session-based — the original token isn't needed again unless you're pairing a new device.

## Managing access later

`workbench auth` manages access after the initial pairing flow:

- issue additional pairing credentials
- list active sessions
- revoke pairing links or sessions

`workbench auth --help` and the nested subcommand help pages have the full reference.

## Security notes

- Treat pairing URLs and pairing tokens like passwords.
- Prefer binding `--host` to a trusted private address (Tailnet IP, etc.) over exposing the server broadly.
- Anyone with a valid pairing credential can create a session until that credential expires or is revoked.
- Use `workbench auth` to revoke credentials or sessions you no longer trust.
