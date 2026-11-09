# 1Password Connect on a remote server

Use a 1Password Connect server when you already run one, for example on a home server or in Kubernetes, and
want the T3 Code server to read secrets through it. Connect needs no desktop approval, so it works on a
headless or [remote](./remote-access.md) host.

If you do not run Connect, a [service account](./secrets-1password-service-account.md) is simpler. For the
basics, see [Secrets](./secrets.md).

## Set it up

1. In 1Password, create a Connect server and an access token. Limit the token to the vaults T3 Code needs.
2. Deploy the Connect API and sync containers where the T3 Code server can reach them.
3. Install the [1Password CLI](https://developer.1password.com/docs/cli/get-started/) (`op`) on the machine
   that runs the T3 Code server.
4. Put `OP_CONNECT_HOST` and `OP_CONNECT_TOKEN` in the server's environment. `OP_CONNECT_HOST` is the Connect
   API's address, including the port if it is not the default for its scheme. Use an `https://` address
   unless Connect runs on the same machine or a private network you trust, because the token and secrets
   travel over that connection. For a
   [background service](./background-service.md), add both to `service.env` and restart the service. See
   [Configure the service environment](./background-service.md#configure-the-service-environment).
5. In **Settings → Secrets**, select **Add provider**. The account is required, but `op` ignores it while
   Connect is configured, so enter any sign-in address such as `my.1password.com`.

Then use references as usual, for example `op://Automation/provider-token/credential`.

## Check that it works

On the server's machine, set `OP_CONNECT_HOST` and `OP_CONNECT_TOKEN` in your shell to the values the
server uses. Confirm the address is a Connect server, then read a secret with a clean environment so only
the Connect variables can sign in:

```bash
curl -s "$OP_CONNECT_HOST/health"
env -i PATH="$PATH" HOME="$(mktemp -d)" OP_CONNECT_HOST="$OP_CONNECT_HOST" OP_CONNECT_TOKEN="$OP_CONNECT_TOKEN" \
  op read --no-newline "op://Automation/provider-token/credential" >/dev/null && echo "Secret read"
```

The health response names the 1Password Connect API. Any other page means the address points at something
else, such as a reverse proxy that answers for every hostname.

This checks the Connect variables in your shell, not the server's own environment. To confirm the server
can read the secret, use the reference in a setting and select **Refresh** in **Settings → Providers**. A
secret it cannot read shows an error naming the secret provider.

## Things to know

- Agents run with the server's environment, so an agent can use the Connect token to read anything it can.
  Give the token only vaults whose items you would let an agent read.
- Through Connect, `op` can read items but cannot list vaults or accounts. Test with `op read`, not
  `op vault list`.
- A name in a reference can contain letters, digits, spaces, `.`, `_`, and `-`. An item titled
  `Service Token: CI` cannot be written as a reference, so use its item ID instead, for example
  `op://Automation/<item-id>/credential`.
- A Connect token sees only the vaults it was created for. A reference to any other vault cannot be read.
- T3 Code waits up to 45 seconds for 1Password. After that the secret counts as unreadable and the feature
  that needs it shows an error naming the secret provider.
- Do not set `OP_SERVICE_ACCOUNT_TOKEN` in the same environment.
