# Credential storage and review

Hyakki's current server secret files are private to the server user, not encrypted by Hyakki. File permissions do not protect against that account, an unencrypted backup, or offline disk access. The 1Password provider stores references and fetches values on demand. Do not store primary passwords or account refresh tokens in the server file store.

Changes to credential handling, authentication, and review policy need the approval of the GitHub code owner. The PR notification reads file paths and does not run or check out PR code. Branch protection, not the notification, enforces approval. A code owner cannot approve their own pull request. A repository or organization administrator who can edit branch protection can still change the policy itself.

## Account connections design

Google and Microsoft connections must use the system browser, authorization code with PKCE, short-lived request state, and a loopback callback for the local desktop. The browser and identity provider handle passkeys, including phone approval. Hyakki must never collect passwords, import browser cookies, or accept pasted OAuth tokens from agents.

Session connections use access tokens in memory only. Persistent connections require the machine's OS credential store, with no raw-file fallback. A locked or unavailable store pauses the connection. The database can hold an account label, granted scopes, and a credential reference, but not credential bytes. A remote Hyakki host needs its own secure store before it can automate a connection.

Agents call scoped mailbox operations. Only the server can exchange or refresh tokens. Read, modify, and send grants are separate, and scheduled jobs are bound to an approved account and operations. Sending mail should require explicit approval in the initial release. Users need to see which content will go to a hosted model before enabling a schedule.

Proton Pass vault references are separate from account connections. A connector should support a dedicated scoped CLI session, read only the requested fields, never put secret values in arguments or logs, and fail closed if the session is unavailable.
