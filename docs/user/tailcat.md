# Tailcat Remote Access

Tailcat connects two machines directly through an encrypted tunnel without a VPN, a
tailnet, port forwarding, or a public address. T3 Code ships Tailcat built in, so a
desktop or headless server on one machine can be reached from the T3 Code desktop app on
another machine by pasting one code.

Use it when the machines are on different networks, when you cannot install Tailscale, or
when you want a connection that is trusted per device instead of per network.

## What you need

- T3 Code on both machines. Tailcat is bundled; nothing else to install.
- Outbound internet access on both sides. Tailcat finds a direct path when it can and
  falls back to an encrypted relay when it cannot.
- Access to Settings → Connections on the machine you want to reach.

## Enable it on the machine you want to reach

1. Open Settings → Connections.
2. In "This environment", find **Remote access via Tailcat** and turn it on.
3. Wait for the status to read **Ready**. The card shows the machine's Tailcat address and
   which Tailcat build is in use.
4. Click **Create connection code**. Copy the code, or scan the QR from your phone to send
   it to yourself.

A connection code is single use and expires after five minutes. It carries a one-time
pairing credential, so treat it like a pairing URL: share it with one device, then let it
expire. Creating a code opens a short pairing window during which any Tailcat device can
reach the server to redeem a code; the window closes as soon as the code is used or
expires, after which only trusted devices can connect.

Headless servers do the same from the command line:

```bash
npx t3 serve --tailcat
```

The server prints the Tailcat address, a connection code, and a QR code once the tunnel is
ready. `npx t3 remote tailcat code` prints a fresh code for a server that is already
running; `npx t3 remote tailcat status` shows the current state.

## Connect from another machine

1. Open the T3 Code desktop app on the other machine.
2. Open Settings → Connections and click **Add environment**.
3. Choose **Tailcat**, paste the code, and click **Connect**.

The app starts a tunnel, pairs with the server, and saves the environment. From then on it
reconnects on its own, including after restarts and network changes, without a new code.
The saved environment shows "Tailcat · Direct" or "Tailcat · Relay" so you can tell how the
traffic is flowing.

Tailcat environments are managed by the desktop app. The web app at app.t3.codes and the
mobile app cannot start a Tailcat tunnel themselves, so keep using pairing URLs or T3
Connect for those.

## Trusted devices

Every device that redeems a connection code becomes a trusted device on the server. The
Remote access card lists them with the time they were added and last seen. You can rename
a device, or revoke it. Revoking removes its transport access and signs it out at the same
time. To let it back in, create a new connection code and connect again.

If you suspect the server's Tailcat identity leaked, use **Regenerate identity**. The
server gets a new address, every existing connection code stops working, and every saved
Tailcat environment on other devices needs a fresh code.

## When something is off

- **Status shows Unavailable.** The bundled Tailcat build could not start. The card shows
  the reason. Reinstalling T3 Code restores the bundled binary; advanced users can point
  the server at their own build with the `T3CODE_TAILCAT_BINARY` environment variable.
- **The other machine says "not trusted or offline".** Either the server is off, remote
  access is disabled, or the device was revoked. Create a fresh connection code on the
  server and connect again.
- **The connection shows Relay instead of Direct.** Both sides could not find a direct
  path, so traffic goes through an encrypted relay. It still works; it is just slower.
  Use "Probe" in the environment's details to re-check the path later.
- **Copy diagnostics** in the environment's details gathers the tunnel status, the path
  probe, and the recent forwarder output with secrets removed. Attach it to a bug report.

## Working across two of your own machines

Two T3 Code servers can pair with each other over Tailcat, so a run can be started on one
machine and executed on another. See the **Federation** section in Settings → Connections:
create a peer code on one machine, add it on the other, choose what each side may do, and
start runs on the peer from the same screen. Every remote run and every artifact says which
machine it executed on.

Headless servers do the same from the command line: `npx t3 peer code` on one machine,
`npx t3 peer add <code>` on the other, then `npx t3 peer list`, `npx t3 peer projects <peer>`
and `npx t3 peer run <peer> <project> "<prompt>" --wait`. Both commands accept `--base-dir`
to target a specific data directory and `--json` for scripting.
