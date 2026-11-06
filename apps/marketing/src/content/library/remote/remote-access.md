---
title: "Remote access to your machines"
description: "Use T3 Code remotely through T3 Connect, SSH, Tailscale HTTPS, or direct pairing, with setup steps and an explanation of access permissions."
updated: 2026-11-04
sources:
  - label: "Remote access"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md"
  - label: "Run a background service"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/background-service.md"
  - label: "Remote architecture"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/internals/remote.md"
  - label: "T3 Connect trust boundary"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/internals/t3-connect.md"
  - label: "Environment authentication"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/internals/environment-auth.md"
  - label: "Tailscale transport"
    url: "https://github.com/pingdotgg/t3code/blob/main/packages/tailscale/src/tailscale.ts"
  - label: "SSH transport"
    url: "https://github.com/pingdotgg/t3code/blob/main/packages/ssh/src/tunnel.ts"
faq:
  - question: "How do I use T3 Code remotely?"
    answer: "Run T3 Code on the host and add it from another device through T3 Connect, direct pairing, Tailscale HTTPS, or desktop-managed SSH. The host must remain awake and running."
  - question: "What is T3 Connect?"
    answer: "T3 Connect links your T3 Code environment to your account and provides a managed tunnel address without router forwarding. Agents and project files remain on your host."
  - question: "Does T3 Code support SSH?"
    answer: "The T3 Code desktop app can launch or reuse a server on a Linux or Apple Silicon Mac host and manage its SSH port forward. Install and authenticate the provider CLIs on that host."
  - question: "Can app.t3.codes connect to a plain HTTP server?"
    answer: "The hosted T3 Code web app requires an HTTPS endpoint. A hosted pairing link does not add HTTPS or make an unreachable host reachable."
---

T3 Code lets you run coding agents on a remote machine and control them from a phone, browser, or another desktop. Supported routes include T3 Connect, direct LAN or private-network pairing, Tailscale HTTPS, and desktop-managed SSH. Projects, provider credentials, and agent execution belong to the host environment.

## Choose a remote connection

| Use this route      | When it fits                                                         | What you need                                              |
| ------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------- |
| T3 Connect          | You want an account-linked address without router forwarding         | A linked, running host and the same account on your client |
| Direct pairing      | Your client can reach a LAN, VPN, or other configured server address | Network access and a fresh pairing link                    |
| Tailscale HTTPS     | Both devices use your tailnet and you want HTTPS                     | Tailscale and a Serve endpoint                             |
| Desktop-managed SSH | You want the desktop app to start or reuse a remote server           | SSH access and a supported host with provider CLIs         |

A public URL is also a possible route when you have configured a reachable endpoint. An address alone does not grant access. The environment still authenticates the client.

## Set up T3 Connect

On a desktop host, open `Settings → Sharing & access`, sign in, and enable `T3 Connect`. On a command-line host, use:

```bash
t3 up
```

1. Choose T3 Connect, the local network, or both.
2. Complete the sign-in instructions.
3. On the receiving device, sign in to the same T3 Connect account.
4. Select the environment you want to use.

`t3 connect` is equivalent to `t3 up --connect`. Over SSH, the CLI prints a browser link and short code. Open that link on another device, compare the code, and approve. This flow needs no forwarded OAuth callback port.

T3 Connect brokers the account link and connection bootstrap. Application traffic then travels through the host's managed tunnel address. The host issues and enforces its own access sessions. This setup trusts T3 Connect to authorize connection bootstrapping for linked accounts.

On Linux and macOS, setup uses a [background service](/learn/safety/background-service). Windows does not support that service. Keep its desktop app running with the local environment enabled, or keep the printed `t3 serve` command running. Closing the last desktop window stops its local server.

## Pair directly over your network

On the host desktop, enable `Settings → Sharing & access → Network access`. This change restarts the app. For a command-line service, run:

```bash
t3 up --lan
```

For a foreground server, use `t3 serve --lan`. If the server already runs, `t3 pair` creates a new pairing link without restarting it.

Scan the QR code or paste the URL into `Add environment` on the receiving app. Use a host address that device can reach. `127.0.0.1` refers to the device opening the link, so it cannot identify another computer.

Each new device needs a fresh one-time link. Successful pairing saves access for later connections. Treat the link as a password and exclude it from screenshots and reports.

## Connect with Tailscale HTTPS

Join both devices to the same tailnet. On a desktop host, enable `Settings → Sharing & access → Tailscale HTTPS`. For a new foreground server, run:

```bash
t3 serve --tailscale-serve
```

For an existing server, use `t3 pair --tailscale`. Its URL uses the host's `https://machine.tailnet.ts.net/` address. If the default HTTPS port is occupied, select another with `--tailscale-serve-port`.

The hosted client at [app.t3.codes](https://app.t3.codes) needs HTTPS. A plain HTTP LAN address can instead work through its direct browser URL or the desktop app. On mobile, include `https://` explicitly for an HTTPS endpoint; a bare IP address defaults to HTTP.

## Start remote work through SSH

In the desktop app, open `Settings → Environments → Add environment`, choose `SSH`, and enter your SSH alias or host.

The remote machine must run Linux or macOS on Apple Silicon. It needs `curl` or `wget`, `tar`, and `sha256sum` or `shasum`. Install and authenticate its provider CLIs there. Check that a non-interactive login shell finds them:

```bash
ssh user@example.com 'sh -lc "command -v claude codex"'
```

The first launch downloads the server into `~/.t3/runtime`. Removing the connection stops a server T3 Code launched, but leaves a previously running server alone. If reconnection fails after an app update, retry the launch once.

## Let agents work across linked environments

Connecting a client lets you control another host. The `Linked environments` beta also lets an agent on one machine work on another.

1. Enable `Linked environments` in `Settings → Labs` on both machines.
2. On the machine you work from, open `Settings → Environments → Linked environments`.
3. Choose `Link`, select the destination, and choose its allowed access.
4. Supply a pairing code from the destination if your existing connection cannot manage access there.

A link sets the maximum access for agents arriving from that machine. Each agent's own mode can narrow that access further. Below full access, linked agents can change only threads started through that link. They cannot change the destination's own threads, projects, or settings, and project setup scripts are skipped.

Links last 30 days. Revoke one on the destination through `Settings → Sharing & access`. Forgetting it on the originating machine only removes it there.

## Keep multiple routes and inspect permissions

Open a machine in `Settings → Environments` to inspect its routes. Use `Add route` for another address, then arrange their priority. T3 Code tries the first working route and can return to an earlier route when it becomes available.

With network access enabled, a connected host can also advertise LAN and Tailscale addresses. Learned routes follow address changes. Route order changes how you reach a machine; it does not move existing [threads](/learn/threads/working-with-threads).

Direct pairing and T3 Connect use separate sessions that may grant different permissions. Inspect `Permissions` beside `Routes`, or `Your permissions` on mobile, for the route marked `In use`. Default CLI pairings grant all permissions. Use explicit `--scope` options when issuing a narrower grant, then pair again to replace an existing grant.

Revoking an unused pairing link prevents its redemption. Revoke the client's session to remove access it already holds. Forgetting a saved environment on one client does not deregister it from T3 Connect.

## Use a desktop only as a remote client

Turn off `Local environment` in the desktop app's `Settings → Environments` when that computer should only control other machines. T3 Code restarts without its local server, agents, terminals, or WSL backends. Saved connections, projects, and history remain. Turn the same setting on to restore local operation.

## Next steps

- Continue through the [remote and mobile overview](/learn/remote) or [set up your phone](/learn/remote/mobile-apps).
- Add [mobile notifications](/learn/remote/mobile-notifications) or [share one thread with a guest](/learn/remote/guest-links).
- Watch mobile testing through the [Device panel](/learn/remote/devices).
- Use [T3 Connect troubleshooting](/learn/remote/t3-connect-troubleshooting) when an account, network, or tunnel check fails.
