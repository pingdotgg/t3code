# Secrets

T3 Code can read credentials from a secret provider, so the credential stays in your password
manager and T3 Code saves only a reference to it. Agents can also ask you for a secret in a
private card instead of in the chat.

Secret-provider source pickers are in preview and are not in every build yet. Secret requests from
agents work everywhere.

## Secret providers

1Password is the supported provider. T3 Code reads secrets with the
[1Password CLI](https://developer.1password.com/docs/cli/) (`op`), so `op` must be installed and
signed in on the machine that runs the T3 Code server. When you use T3 Code on another machine or
from your phone, that is the remote machine, not the device in front of you.

A desktop sign-in asks for approval on that machine, which a remote user cannot answer. On a remote
or headless server, sign `op` in with a [service account](./secrets-1password-service-account.md) or a
[Connect server](./secrets-1password-connect.md) instead.

To add one, open **Settings → Secrets**, select **Add provider**, and enter a name and the
1Password account: the shorthand, sign-in address (without `https://`), or ID that
`op account list` shows. Secret providers belong to the environment you are connected to. Each
environment keeps its own list.

## Use a secret reference

Credential fields in Settings, such as provider environment variables and credentials, source
control tokens, usage limit keys, and device host tokens, show a source picker next to the field.
Pick **Value** to save the credential itself, or pick a secret provider and enter a reference such
as `op://vault/item/field`. Copy the reference from 1Password with **Copy Secret Reference**.
Select the check button next to a reference to read it now. If it reads, providers that use it
start using the new value.

T3 Code reads the secret when it needs it, for example when a provider starts. Change the
credential in 1Password and refresh to use the new value.

## When a secret cannot be read

If 1Password is locked or signed out, the provider or feature that needs the secret shows an error
naming the secret provider. Unlock 1Password on the server's machine, then select **Refresh** in
**Settings → Providers**. T3 Code never replaces a saved credential it cannot read with another
login.

## Remove a secret provider

When you remove a secret provider in **Settings → Secrets**, T3 Code lists the fields that read
from it. Removing it clears those fields, so set them again before you need them. The secrets in
1Password are not touched.

## When an agent asks for a secret

An agent that needs a token or password shows a secret request card in the thread instead of asking
you to paste it into the chat. Type or paste the value and select **Save securely**, or select
**Decline**. You can answer from web, desktop, or mobile.

If the environment has a secret provider, the card also lets you pick it and enter a reference
instead of the value. T3 Code reads the secret once, when you answer. If 1Password is locked, the
card says so and the request stays open: unlock it and try again, or enter the value.

The value never appears in the conversation. Most requests keep it from the agent too: T3 Code
passes it to the tool that needs it. When an agent has to run a command with the value, the card
says so instead: the value goes into a private file that the agent's commands can read for about 24
hours.

## Share a vault with agents

In **Settings → Secrets → Agent vaults**, select **Add agent vault**, enter the exact vault name,
then paste its service-account token into the private token field. Install `op` on that
**environment's server**. Use a separate read-only service account restricted to each vault; do not
keep the service-account tokens inside a shared vault. Tokens stay in the server's secret storage,
not in `settings.json`, synced settings, or chat. **Change token** replaces a credential;
**Remove vault** stops new access and deletes its stored token. Revoke unused tokens in 1Password
as well. Commands already running keep the values they were given.

Agent access is either allowed or not—there are no per-use approval prompts. The agent uses
`secret_list` to find item and field references without values, then `secret_run` to execute a
command in its thread's working directory with references mapped to environment variables.
`ssh_keys` can load unencrypted OpenSSH private-key references into a private, temporary SSH agent
on macOS or Linux for git over SSH. Commands need the thread's full-access mode. They time out
after 120 seconds by default (up to 30 minutes), and return bounded output with exact values
masked, including values split across output chunks.

Masking does **not** catch transformed values (for example base64, URL encoding, or separate
characters). These tools help prevent accidental disclosure, not malicious access by a process
running as your user. Share only small vaults whose credentials you trust agents to use.

Web and desktop can manage vaults on local or remote environments. Mobile can use threads with
these tools, but does not yet have a Secrets settings page; manage its server's vaults from web or
desktop. Agent vaults are separate from the secret providers used by credential fields above.
