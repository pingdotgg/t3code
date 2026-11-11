# T3 Connect gateway

The gateway carries public HTTP and WebSocket traffic for T3 Connect Unlimited (beta). Each linked T3 server keeps one outbound WSS connection to `wss://connector.<domain>/connect`, and the gateway routes `https://<key>.<domain>` to it. Hosts install nothing: the connector runs inside the T3 server.

One gateway serves one beta domain. It is a single point of failure: when it restarts, hosts reconnect on their own with backoff.

`deploy/` holds the production setup: Caddy terminates TLS and reaches the gateway through a Unix socket that systemd owns. Loopback TCP would limit the box to about 55,000 connections, because Caddy opens one per host.

1. Build the executable with Go 1.25 or later.

   ```sh
   cd infra/connect-gateway
   go test -race ./...
   go build -o t3-connect-gateway .
   ```

2. Point a wildcard DNS record for `*.<domain>` at the gateway. Do not proxy it.

3. Get a wildcard certificate for `*.<domain>`. We use certbot with its Cloudflare DNS plugin and `deploy/t3-caddy-cert-deploy` as the deploy hook, which gives Caddy a copy of each renewed certificate:

   ```sh
   certbot certonly --dns-cloudflare --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini \
     --cert-name <domain> -d "*.<domain>" --deploy-hook /usr/local/sbin/t3-caddy-cert-deploy
   ```

4. Install Caddy and `deploy/Caddyfile`, with your domain. Caddy keeps Host, path, and query, and its logs drop paths, queries, and headers: these fields can carry environment credentials and webhook tokens. Allow only ports 22, 80, and 443 in the firewall, and set `net.core.somaxconn=65535` so the socket can hold every host reconnecting at once.

5. Generate a random secret of at least 32 characters. Set it as `RELAY_BETA_GATEWAY_SECRET` on the relay and `T3_CONNECT_RELAY_SECRET` on the gateway. For production, `RELAY_BETA_GATEWAY_SECRET` is a GitHub secret.

6. Write `/etc/t3-connect-gateway/env` (mode 0600), copy the executable to `/usr/local/bin`, install the units from `deploy/`, and start the socket before the service:

   ```sh
   T3_CONNECT_GATEWAY_URL=wss://connector.<domain>/connect
   T3_CONNECT_RELAY_URL=https://<relay-domain>
   T3_CONNECT_RELAY_SECRET=<secret>
   ```

   ```sh
   systemctl enable --now t3-connect-gateway.socket t3-connect-gateway.service
   ```

   systemd refuses to start the socket while an older gateway service is running, so stop that first. Only Caddy can open the socket, and new connections wait in it while the gateway restarts. Outside systemd, the gateway listens on `T3_CONNECT_LISTEN`, a loopback address that defaults to `127.0.0.1:7443`.

7. Set `RELAY_BETA_GATEWAY_TESTERS` to the testers' Clerk user IDs, separated by commas, and `RELAY_BETA_GATEWAY_DOMAIN=<domain>` on the relay (GitHub variables for production), then deploy it. The relay then offers the beta to those accounts, so do this last.

The gateway asks the relay which connector tokens are still linked every 30 seconds, in batches. An unlinked environment loses its route at the next check. If the relay cannot answer, routes stay up for 5 minutes after their last good check, so a short relay outage does not disconnect hosts. New connections are checked in batches too, so after a restart every host is back within seconds instead of waiting for one relay call each.
