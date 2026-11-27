# 1Password service account on a remote server

Use a 1Password service account so a headless, VM, or [background-service](./background-service.md) T3 Code server can read secrets via `op` without desktop approval prompts. See [Secrets](./secrets.md) for basics, or [1Password Connect](./secrets-1password-connect.md) for self-hosted Connect.

## Set it up

1. In 1Password (**Developer → Service Accounts**), create a service account with read access **only** to the vaults T3 Code needs (cannot access Personal/Private/Employee vaults). Copy the one-time token.
2. Install the [1Password CLI](https://developer.1password.com/docs/cli/get-started/) (`op`) on the T3 Code server machine.
3. Set `OP_SERVICE_ACCOUNT_TOKEN` in the server's environment (for a background service, add it to [`service.env`](./background-service.md#configure-the-service-environment) and run `t3 service restart`). Do not set `OP_CONNECT_HOST` / `OP_CONNECT_TOKEN` in the same environment.
4. In **Settings → Secrets → Add provider**, enter any sign-in address (e.g. `my.1password.com`; `op` ignores it while the token is set), then use `op://vault/item/field` references.

## Verify

On the server machine, test with a clean environment:

```bash
env -i PATH="$PATH" HOME="$(mktemp -d)" OP_SERVICE_ACCOUNT_TOKEN="$OP_SERVICE_ACCOUNT_TOKEN" \
  op read --no-newline "op://Automation/provider-token/credential" >/dev/null && echo "Secret read"
```

## Notes

- **Agent scope**: Agents inherit the server's environment and can read any vault accessible to the service account—grant only vaults you're comfortable exposing to agents.
- **Reference names**: Use item IDs if an item title contains characters outside letters, digits, spaces, `.`, `_`, and `-`.
- T3 Code times out secret reads after 45 seconds.
