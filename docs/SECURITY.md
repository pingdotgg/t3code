# Security

## Reporting a vulnerability

Please report security problems privately through
[GitHub security advisories](https://github.com/SwashX-dev/continuum-ide/security/advisories/new)
rather than public issues. Vulnerabilities that also affect upstream T3 Code should be reported to
T3 Tools Inc. as well.

## Security model

- **Local by default.** The server listens on loopback only. Remote access (local network,
  Tailscale, T3 Connect) is off until you enable it in **Settings → Sharing & access** and pair each
  device; paired devices get scoped, revocable credentials.
- **Agent permissions.** Agents run with the permission mode you choose per conversation:
  Supervised, Auto-accept edits, Auto, or Full access. Approvals are shown in the conversation.
- **Browser isolation.** Pages in the in-app browser run in a sandboxed, separate session. Web content
  cannot issue commands to agents; agent browser control goes through permission-checked tools.
- **Credentials.** Agent sign-ins stay in each agent's own storage. Secrets can be read from a
  password manager (1Password) by reference, and agents ask for secrets in a private card instead
  of the chat. The desktop app keeps its own tokens in the OS credential store.
- **Data isolation from T3 Code.** Continuum uses its own data folder and browser profile and never
  imports another app's profile or encryption keys.
- **No covert telemetry.** Analytics are off and have no default endpoint ([PRIVACY.md](./PRIVACY.md)).
- **Unsigned installers.** Release installers are not code-signed. Verify downloads with the
  `SHA256SUMS` file attached to each release.
