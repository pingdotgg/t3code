# Cloudflare Tunnel

T3 Code can keep a user-managed named `cloudflared` tunnel running with the desktop app. T3 starts and stops the local connector process; Cloudflare remains responsible for the tunnel, DNS, credentials, and Access policies.

## Prerequisites

Install `cloudflared` and make sure it is available on `PATH`. T3 also recognizes the `T3CODE_CLOUDFLARED_PATH` override and its managed Cloudflare binary when available.

Authenticate the Cloudflare CLI once:

```bash
cloudflared login
```

The command opens a browser. Choose the Cloudflare zone that owns the hostname you want to use. This creates the local certificate needed to create and manage named tunnels.

## Create a named tunnel

Create the tunnel and keep the generated tunnel ID and credentials path:

```bash
cloudflared tunnel create t3-code
```

Copy [`config.example.yml`](../examples/cloudflared/config.example.yml), replace the tunnel ID, credentials path, hostname, and origin values, then validate it:

```bash
cloudflared tunnel --config /absolute/path/to/config.yml ingress validate
```

The example uses T3's default desktop backend port, `3773`, and keeps the origin on loopback. If the desktop backend uses another configured port, update the `service` value in the YAML.

Create the DNS record for the hostname:

```bash
cloudflared tunnel route dns t3-code t3.example.com
```

Cloudflare Tunnel supports T3's HTTP and WebSocket traffic. If you want an additional login gate, create a Cloudflare Access self-hosted application for the hostname and add your Google identity or email policy. T3 does not configure Cloudflare Access or Google authentication for you.

## Enable it in T3

In the desktop app:

1. Open **Settings** → **Connections**.
2. Find **Cloudflare Tunnel** under **This environment**.
3. Enter the absolute path to the YAML configuration file.
4. Select **Save**, then enable the switch.

T3 starts `cloudflared tunnel --config /path/to/config.yml run` immediately and again on desktop startup. The Connections setting reports whether the local process is running or failed. A running process does not prove that the Cloudflare hostname or the YAML origin is reachable; check the hostname and Cloudflare dashboard if requests still fail.

T3 does not rewrite your YAML, create DNS records, copy tunnel credentials, infer hostnames, or add the Cloudflare hostname to pairing endpoint suggestions. Pair through the hostname you configured using a normal T3 pairing link.

Disable the switch to stop the connector. T3 also stops the connector when the desktop app exits.

## Troubleshooting

- **cloudflared was not found:** install it, add it to `PATH`, or set `T3CODE_CLOUDFLARED_PATH` to the executable.
- **The tunnel process runs but the site is unreachable:** verify the `service` URL, the T3 backend port, the hostname route, and any Cloudflare Access policy.
- **The desktop port changed:** update the YAML origin and restart or re-save the Cloudflare Tunnel setting. T3 does not modify ingress configuration automatically.
- **The tunnel is exposed without a login:** configure Cloudflare Access for the exact hostname. T3 pairing authentication still applies to the T3 server.
