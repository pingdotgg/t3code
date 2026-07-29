# Seamless Remote Connections

SurgeCode Cloud gives the macOS host and iPhone companion a stable connection
without requiring both devices to share a LAN or VPN.

## Architecture

1. The Mac links its environment to the Cloudflare-hosted relay.
2. The relay provisions a named Cloudflare Tunnel and a stable DNS endpoint
   for that environment.
3. The Mac runs the pinned `cloudflared` connector as a supervised child
   process. It makes an outbound-only connection, so NAT, hotel Wi-Fi, mobile
   hotspots, and changing public IP addresses do not require port forwarding.
4. The iPhone signs in, discovers the linked environment through the relay,
   and obtains a short-lived scoped connection credential.
5. Normal HTTP and WebSocket traffic then flows directly from the iPhone to
   the Mac's tunnel endpoint. The relay is a control plane, not a proxy for
   coding-session traffic.

The local-network endpoint remains available as an automatic low-latency path
when both devices share a LAN. Tailscale is not required and is no longer
offered in the macOS connection UI.

Cloudflare Quick Tunnels (`trycloudflare.com`) are intentionally not used:
they are development-only, have no SLA, and do not provide a durable hostname.
SurgeCode provisions named, remotely managed tunnels instead.

## Cost model

This design minimizes hosted traffic because the relay only handles account,
discovery, credential, health, and notification operations. The high-volume
app traffic terminates at the per-Mac tunnel.

For a personal or small-team deployment, Cloudflare Workers, Queues, Tunnel,
Clerk, and Axiom can often remain within low-volume or free allowances. The
current Alchemy stack provisions a single-node PlanetScale Postgres database;
PlanetScale currently lists that tier from $5/month. An Apple Developer
membership is also needed for the APNs key. Verify the current provider plans
before enabling production. Railway is not needed in the traffic path; using
it as an always-on WebSocket proxy would add cost and another failure domain
without improving reachability.

## One-time account setup

The production deployment uses five service boundaries:

- Cloudflare: Worker, Queues, DNS, Hyperdrive, and named tunnels.
- PlanetScale: relay metadata.
- Clerk: user identity and relay JWTs.
- Axiom: operational traces.
- Apple Developer: APNs credentials for companion notifications.

Create two Cloudflare DNS zones (or use two subdomains in zones already in the
account): one for the relay API and one for environment tunnel hostnames. The
API becomes `relay.<RELAY_API_ZONE_NAME>` unless `RELAY_DOMAIN` overrides it.

Configure the repository and its `production` GitHub environment exactly as
listed in [`infra/relay/README.md`](../../infra/relay/README.md#deployment-ci).
Set `SERGECODE_RELAY_DEPLOY_ENABLED` to `true` only after configuring and verifying
the required credentials. The **Deploy SurgeCode Cloud relay** workflow requires
that variable for both manual dispatches and relay-relevant changes from `main`.

The app release environment must also expose the public client configuration:

- `T3CODE_RELAY_URL`
- `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`
- `EXPO_PUBLIC_CLERK_JWT_TEMPLATE`

These are public identifiers, not secrets. Relay deploy output writes the
derived `T3CODE_RELAY_URL` to the runner checkout for local builds; production
release configuration must store it durably in GitHub.

## Updates and version skew

Desktop-supervised environments advertise the macOS app version and monotonic
Sparkle build number. The iPhone compares that build number with the public
Sparkle appcast:

- Current hosts show their installed version.
- Older hosts show the available version.
- Hosts that predate version reporting show a one-time-upgrade advisory rather
  than receiving an RPC they do not understand.

For a compatible older host, **Update Mac** sends an authenticated,
operate-scoped request over the existing connection. The local macOS app opens
its normal signed Sparkle updater. The remote device cannot silently install
or execute an arbitrary package; installation remains visible and confirmed
on the Mac. After relaunch, the managed tunnel and persisted environment link
are re-established automatically.

## Operational checks

After deployment:

1. Link a Mac from the Cloud section and confirm its Internet endpoint appears
   in Settings > Devices.
2. Disable Wi-Fi on the iPhone and connect over cellular.
3. Move the Mac to a different network and confirm the same environment
   reconnects without re-pairing.
4. Stop and relaunch SurgeCode; confirm the managed endpoint returns.
5. Test with an older released Mac build and confirm the iPhone shows the
   update advisory and opens Sparkle on request.

If the workflow fails before checkout, its validation step lists the missing
variable or secret names without printing their values.
