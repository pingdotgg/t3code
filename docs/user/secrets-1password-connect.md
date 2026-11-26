# 1Password Connect on a remote server

Read secrets from a self-hosted 1Password Connect server on headless or [remote](./remote-access.md) T3 Code hosts without desktop approval prompts. If you don't already run Connect, a [1Password service account](./secrets-1password-service-account.md) is simpler. See [Secrets](./secrets.md) for basics.

## Set it up

1. In 1Password, create a Connect server and access token scoped **only** to the vaults T3 Code needs.
2. Deploy the Connect API and sync containers where the T3 Code server can reach them.
3. Install the [1Password CLI](https://developer.1password.com/docs/cli/get-started/) (`op`) on the T3 Code server machine.
4. Set `OP_CONNECT_HOST` (use `https://` unless local or on a trusted private network) and `OP_CONNECT_TOKEN` in the server's environment (for a background service, add them to [`service.env`](./background-service.md#configure-the-service-environment) and run `t3 service restart`). Do not set `OP_SERVICE_ACCOUNT_TOKEN` in the same environment.
5. In **Settings → Secrets → Add provider**, enter any sign-in address (e.g. `my.1password.com`; `op` ignores it while Connect is configured), then use `op://vault/item/field` references.

## Verify

On the server machine, test with a clean environment:

```bash
curl -s "$OP_CONNECT_HOST/health"
env -i PATH="$PATH" HOME="$(mktemp -d)" OP_CONNECT_HOST="$OP_CONNECT_HOST" OP_CONNECT_TOKEN="$OP_CONNECT_TOKEN" \
  op read --no-newline "op://Automation/provider-token/credential" >/dev/null && echo "Secret read"
```

## Notes

- **Agent scope**: Agents inherit the server's environment and can read any vault accessible to the Connect token—grant only vaults you're comfortable exposing to agents.
- **Reference names**: Use item IDs if an item title contains characters outside letters, digits, spaces, `.`, `_`, and `-` (e.g. colons).
- `op` over Connect supports `op read` (not `op vault list`), and T3 Code times out secret reads after 45 seconds.
