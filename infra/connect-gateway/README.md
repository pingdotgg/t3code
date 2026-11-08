# T3 Connect gateway

The gateway carries public HTTP and WebSocket traffic for T3 Connect Unlimited (beta). Each linked T3 server keeps one outbound WSS connection to `wss://connector.<domain>/connect`, and the gateway routes `https://<key>.<domain>` to it. Hosts install nothing: the connector runs inside the T3 server.

One gateway serves one beta domain. It is a single point of failure: when it restarts, hosts reconnect on their own with backoff.

1. Build the executable with Go 1.25 or later.

   ```sh
   cd infra/connect-gateway
   go test -race ./...
   go build -o t3-connect-gateway .
   ```

2. Point a wildcard DNS record for `*.<domain>` at the gateway, and terminate TLS for it in front of the gateway. Forward HTTP requests and WebSocket upgrades to `127.0.0.1:7443`, preserving Host, path, and query. Disable query, header, and body logging at ingress: these fields can carry environment credentials.

3. Generate a random secret of at least 32 characters. Set it as `RELAY_BETA_GATEWAY_SECRET` on the relay and `T3_CONNECT_RELAY_SECRET` on the gateway. For production, `RELAY_BETA_GATEWAY_SECRET` is a GitHub secret.

4. Start the gateway, for example as a systemd service that restarts on failure.

   ```sh
   T3_CONNECT_GATEWAY_URL=wss://connector.<domain>/connect \
   T3_CONNECT_RELAY_URL=https://<relay-domain> \
   T3_CONNECT_RELAY_SECRET=<secret> \
   ./t3-connect-gateway serve
   ```

   `T3_CONNECT_LISTEN` chooses a different loopback port.

5. Set `RELAY_BETA_GATEWAY_DOMAIN=<domain>` on the relay (a GitHub variable for production) and deploy it. The relay then offers the beta to clients, so do this last.

The gateway asks the relay which connector tokens are still linked every 30 seconds, in batches. An unlinked environment loses its route at the next check. If the relay cannot answer, routes stay up for 5 minutes after their last good check, so a short relay outage does not disconnect hosts.
