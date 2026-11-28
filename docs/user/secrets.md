# Secrets

Keep credentials in Hyakki's encrypted local vault or reference them from 1Password. Let agents request one-off credentials through a private approval card instead of chat history.

**Settings → Secrets** is available by default when connected to a current Hyakki server. No vault is connected automatically.

## Save and use a vault entry

First open **Settings → Secrets → Hyakki vault → Set PIN** on the owner's desktop. Choose a non-repeating, non-sequential PIN with 6 to 8 digits and confirm it. No default PIN is set for you. Initial setup clears pending credential approvals from older builds. Five wrong attempts start a persistent cooldown; restarting Hyakki does not reset it.

Select **Add credential**. Choose a service to connect an account, or a storage type to save a value without connecting it to a service:

| Type          | Example                                       | Protected fields            |
| ------------- | --------------------------------------------- | --------------------------- |
| API token     | A provider API key                            | Token                       |
| Website login | GitHub personal, website `https://github.com` | Username or email, password |
| Secure note   | Recovery instructions                         | Note text                   |

Names and website addresses appear in the list. Keep sensitive information in the protected fields. Creating, changing, and deleting all three types requires an encrypted environment plus settings and provider-management permissions. The password generator runs locally. **Show** reveals only the value you are currently entering, not a stored value.

New entries default to **Ask every time**. **Allow protected use** is a PIN-confirmed grant for provider credential resolution and approved protected requests, not permission to display real fields. Command disclosure always requires a new PIN confirmation and a separate acknowledgment. This PIN protects Hyakki's API operations; it cannot isolate unrestricted programs running as your OS user.

**Example: use a saved API token.** Save an API token called `GitHub API`, choose **Allow protected use**, and confirm with your PIN. In a provider's credential or environment-variable setting, change the source from **Value** to **Hyakki vault**, then choose `GitHub API`. Hyakki saves a reference, not the token in settings. The check button reads the reference server-side and reports success without returning the token. **Copy reference** copies only its `hyakki-vault://…/token` address. Replacing a token affects subsequent reads; an already-running provider can retain its previous environment until refreshed or restarted.

**Example: answer an agent's login request.** Save a website login for `https://github.com`. Ask the agent: "Request my GitHub username and password through a credential card for https://github.com, using file delivery. Do not ask me to paste them in chat or print their contents." When the card appears, choose **Allow from vault**, select the login, map its saved username and password to the requested fields, enter your PIN, explicitly allow the agent's commands to read those fields, and select **Approve command access**. The agent can then read those private files from its commands. This is an explicit command handoff, not a private browser autofill integration. This requires task and provider-management permission; browsing the vault also requires settings permission. Approval covers that request only, not all future requests or a standing schedule grant. A missing website, different subdomain, port, or protocol cannot use the login. The server checks the exact HTTPS origin again when approving.

Requests use the existing one-use credential broker. Protected tools do not return values to the model. A request with file delivery explicitly gives the agent's commands access through owner-only files for up to 24 hours. Its approval card says which delivery is being used. Website checking is not a sandbox for those commands after approval. Hyakki does not yet have a private browser autofill consumer; a login reference without a target-aware protected consumer cannot be used as a substitute for that integration. Full-access agents running as your user are not isolated by vault encryption.

Use **Edit** to rename an entry or replace its fields. Blank protected fields keep their previous values. Stored values are never fetched back into the editor. Search by name or website. **Edit**, **Delete**, and access-mode changes require PIN confirmation. Changing an entry or the PIN invalidates pending vault approvals. Deleting an entry does not revoke a token at its issuer or erase values already delivered to an agent or provider.

## Connect a service

In **Settings → Secrets → Add credential**, choose the service, then give the account a name you can recognize in chat. Hyakki does not supply a shared OAuth app or ask you to send a password to an agent.

The current source build includes all twelve services below. If your installation only lists Gmail, GitHub, GitLab and Slack, it is an earlier build. There is no published Hyakki release to download for the additional connections.

| Service    | What you provide in the private editor                                                                                                                        | What you can ask for                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Gmail      | Your Google OAuth **Web application** client ID and secret, followed by Google consent                                                                        | Recent messages in Inbox or Spam                                               |
| GitHub.com | A [fine-grained personal access token](https://github.com/settings/personal-access-tokens) restricted to the repositories you choose, with read-only metadata | Repositories visible to that token                                             |
| GitLab.com | A [personal access token](https://docs.gitlab.com/user/profile/personal_access_tokens/) with `read_api`                                                       | Projects the connected account belongs to                                      |
| Slack      | A token from your installed Slack app with [`channels:read`](https://docs.slack.dev/reference/scopes/channels.read/)                                          | Public channels visible to that token, not private messages or channel history |
| Airtable   | A personal access token with `schema.bases:read` on specific bases                                                                                            | Names of accessible bases                                                      |
| Asana      | A dedicated personal access token; it acts with the account's permissions                                                                                     | Names of visible workspaces                                                    |
| Linear     | A personal API key with Read permission, restricted to the teams you need                                                                                     | Names of visible teams                                                         |
| Netlify    | A personal access token; it is not limited to site reads                                                                                                      | Site names (called projects in the Netlify dashboard)                          |
| Notion     | An internal connection token with Read content; grant access to selected pages                                                                                | Titles of shared pages returned by search                                      |
| Todoist    | The account's personal API token; it is not read-only                                                                                                         | Active project names                                                           |
| Typeform   | A personal access token with `accounts:read` for the connection check and `forms:read`                                                                        | Form titles, not responses                                                     |
| Vercel     | An account access token scoped to one project or team; not an AI Gateway key                                                                                  | Project names in that scope                                                    |

For Gmail, copy Hyakki’s **OAuth redirect URL** into **Authorized redirect URIs** on a Google **Web application** client, enable the Gmail API, then save the client ID and secret in the vault. **Authorized JavaScript origins** is not used by this connection. Choose **Continue to Google**, approve access, then return to Hyakki and enter your vault PIN to **Finish connection**. Saving the client alone does not connect a mailbox. [Step-by-step setup](../operations/credential-storage.md#register-a-google-client-for-a-vault-entry).

For a new app that connects only your own Google account, [Google’s Personal mode](https://support.google.com/cloud/answer/15544987#zippy=%2Cquick-setup-for-personal-use-personal-mode) avoids test users and the seven-day test authorization expiry. Only the account that created the Personal app can sign in; an existing External or Internal app cannot switch to this mode. If your existing app is **External → Testing**, add the intended Gmail address under **Google Auth Platform → Audience → Test users**. This is a Google app setting, and self-hosted n8n has the same requirement.

If Google returns an expired or already-used sign-in page, choose **Restart Google sign-in** in the open Hyakki dialog. Complete only the newest Google sign-in window, then finish the connection in Hyakki. There is no need to re-enter a saved client ID and secret.

For token-based services, Hyakki verifies the token against the service before saving it. A standalone **API token** entry is not a connected service, and a saved website password is not a Google grant.

In chat, type `@`, select the lock-marked credential, and ask for an operation. For example: “Show my five latest Spam messages from `@Personal mail`” or “List three repositories from `@Work code`.” That tag selects the account once. The private card shows what will be read; enter your vault PIN **there**, or decline. The approving client shows the results. The agent gets only a count, never the PIN, token or results. A read defaults to five and returns at most twenty; it can return fewer if there are fewer matches.

Remove an unwanted connection in **Settings → Secrets**. Removing a credential locally does not revoke it at the service. Revoke old tokens with their issuer. Disconnecting a Google account keeps its saved client registration; delete the entry to remove both. To revoke Google's grant, remove the app in your [Google Account connections](https://myaccount.google.com/connections).

## Connect 1Password

Install and sign in to the [1Password CLI](https://developer.1password.com/docs/cli/) (`op`) on the **Hyakki server machine**. On headless or remote servers, use a [1Password service account](./secrets-1password-service-account.md) or [1Password Connect](./secrets-1password-connect.md) so `op` doesn't wait for desktop approval.

1. Open **Settings → Secrets → Add provider** (configured per environment).
2. Enter a name and the 1Password account shorthand, sign-in address (without `https://`), or ID from `op account list`.

## Use secret references

Credential fields in Settings (provider env vars, source control tokens, usage keys, device host tokens) include a source picker: choose **Value** for a literal value or select your 1Password provider and paste a reference like `op://vault/item/field`.

- Click the check button to verify a reference immediately.
- Hyakki reads secrets on demand (e.g. when starting a provider). If 1Password is locked, unlock it on the server and click **Refresh** in **Settings → Providers**.
- Removing a secret provider clears fields referencing it in Hyakki without touching 1Password.

## What the vault controls

**Ask every time** applies when Hyakki uses that credential. It does not control a provider's independently configured tools or a full-access shell. For a tagged account read, Hyakki uses only the connection saved on that entry, not an account signed in elsewhere.

## Mention a saved credential

In the desktop or web composer, type `@` followed by the vault entry's name, such as `@gmail`, and select the lock-marked result. The composer shows a colored lock chip and sends it as `vault:"Gmail"`. It sends only that name, so choose a label you are comfortable putting in the conversation. It does not grant permission or send any saved fields.

For a tool that accepts a protected secret reference, the card shows the tagged entry and what the agent wants to do. Enter your vault PIN there to approve once, or decline. You don't have to pick the entry again or type its password. For example, you can tag a saved signing token when asking Hyakki to set up a signed webhook task. The tool receives a one-use reference; the model gets neither the PIN nor the token.

An unconnected Gmail tag can be connected from its read request on the host desktop. If a request has no protected tool, the agent should stop without asking for credentials.

## When an agent asks for a secret

When an agent calls `request_secret`, Hyakki displays a private card in the thread (web, desktop, and mobile) instead of asking you to paste into chat.

- Enter a new value and click **Save securely**, or **Decline**. On desktop and web, choose **Allow from vault** to pick a saved credential. Hyakki asks for your vault PIN unless a protected-use grant applies. Giving stored fields to commands always requires fresh PIN confirmation and explicit disclosure consent.
- Values never appear in conversation history. For Hyakki tools, the secret is passed directly without exposing it to the agent; for shell commands, the card tells you that the value is written to a private temporary file readable by the agent's commands for ~24 hours.
