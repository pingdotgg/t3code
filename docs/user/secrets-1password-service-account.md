# 1Password service account on a remote server

Use a 1Password service account when the T3 Code server runs on a machine you are not sitting at, such as a
headless host, a VM, or a [background service](./background-service.md) you reach through
[remote access](./remote-access.md).

Signing in to 1Password through its desktop app asks for approval on the server's machine. A remote user
never sees that prompt, so the secret cannot be read. A service account signs in with a token instead, so
nothing needs approving.

For the basics, see [Secrets](./secrets.md). To use a self-hosted Connect server instead, see
[1Password Connect](./secrets-1password-connect.md).

## Set it up

1. In 1Password, open Developer, then Service Accounts, and create one.
2. Give it read access to only the vaults T3 Code needs. Access is fixed when the account is created, and a
   service account cannot reach Personal, Private, or Employee vaults.
3. Copy the token. It is shown once.
4. Install the [1Password CLI](https://developer.1password.com/docs/cli/get-started/) (`op`) on the machine
   that runs the T3 Code server.
5. Put `OP_SERVICE_ACCOUNT_TOKEN` in the server's environment. For a background service, add it to
   `service.env` and restart the service. See
   [Configure the service environment](./background-service.md#configure-the-service-environment).
6. In **Settings → Secrets**, select **Add provider**. The account is required, but `op` ignores it while
   the token is set, so enter any sign-in address such as `my.1password.com`.

Then use references as usual, for example `op://Automation/provider-token/credential`.

## Check that it works

On the server's machine, set `OP_SERVICE_ACCOUNT_TOKEN` in your shell to the same token the server uses,
then read a secret with a clean environment so only the token can sign in:

```bash
env -i PATH="$PATH" HOME="$(mktemp -d)" OP_SERVICE_ACCOUNT_TOKEN="$OP_SERVICE_ACCOUNT_TOKEN" \
  op read --no-newline "op://Automation/provider-token/credential" >/dev/null && echo "Secret read"
```

If it prints `Secret read`, the token can read the secret. This checks your shell, not the server's own
environment. To confirm the server can read it, use the reference in a setting and then use the feature
that needs it. If the server cannot read the secret, that feature shows an error naming the secret provider.

## Things to know

- Agents run with the server's environment, so an agent can use the token to read anything the service
  account can. Give it only vaults whose items you would let an agent read.
- A name in a reference can contain letters, digits, spaces, `.`, `_`, and `-`. An item titled
  `Service Token: CI` cannot be written as a reference, so use its item ID instead, for example
  `op://Automation/<item-id>/credential`.
- T3 Code waits up to 45 seconds for 1Password. After that the secret counts as unreadable and the feature
  that needs it shows an error naming the secret provider.
- Do not set `OP_CONNECT_HOST` and `OP_CONNECT_TOKEN` in the same environment.
