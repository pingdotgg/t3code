# Vault access and disclosure

## Implemented boundary

The encrypted local vault now requires an owner-configured 6 to 8 digit PIN. It is a server-side step-up check, not a renderer-only button. PIN setup is restricted to the local desktop or administrative startup identity; a normal paired client cannot bootstrap it. Changing an existing PIN requires its current value. There is no in-app PIN reset bypass.

`VaultAccess.ts` stores a salted scrypt verifier inside the already encrypted server store. It never stores the PIN itself. Verification uses constant-time comparison. Failed attempts are reserved persistently before verification, including malformed guesses. Five wrong attempts start a one-minute cooldown, with increasing delays capped at one hour. Restarting the server does not clear the counter. Repeated and simple sequential PINs are refused at setup.

PINs are entered only in authenticated UI controls, represented as redacted values in the RPC contract, cleared after submission, and excluded from sensitive RPC tracing and command error reporting. This is not end-to-end encryption against the backend: the trusted backend receives the PIN to verify it. Use a protected local connection or TLS for remote access.

Every entry defaults to **Ask every time**. **Allow protected use** is a PIN-confirmed grant for provider credential resolution and approved protected requests, not permission to display the real fields. A provider token in ask-first mode does not silently resolve; the owner must explicitly allow protected use before binding it to a provider.

Editing, deleting, changing access rules, and changing the PIN require verification. No write callback executes before that check. All entry modes, including allow, require a fresh PIN plus an explicit disclosure acknowledgment for command-file delivery. External secret-provider request answers also require PIN confirmation. Raw `hyakki-vault` reference answers are refused so that route cannot evade the saved-entry approval path.

New broker copies carry the policy epoch. Changing the PIN or editing an entry changes that epoch, so pending approvals cannot later consume their copied values. First PIN setup removes pre-PIN pending credential records while retaining the request salt. Already delivered files, already revealed values, and tokens already applied to a running provider are not recoverable by changing a policy. File access is explicitly disclosed and can last up to the existing 24-hour limit.

## Service access and disclosure

The Gmail reader uses the [owner's OAuth client](credential-storage.md#register-a-google-client-for-a-vault-entry) and a Google grant bound to that vault entry. A tag identifies the entry; it does not authorize a read. The private approval binds the selected address, registration revision, folder, count and thread. The approving client receives the list; the model receives only the displayed count. Sender addresses, subjects and snippets are private data even without an OAuth token. A model that did not see them cannot summarize them.

Each [connected service](../user/secrets.md#connect-a-service) has a fixed read operation. The agent cannot supply a URL, headers or an arbitrary method. Approving one read does not authorize other operations, accounts, threads or future requests. Only the approving client receives the private list; it is not saved as an assistant reply.

Hyakki does not control Nod or independently connected MCP servers. Do not expose an unrestricted mail tool as a substitute for the vault reader. Any additional connector must distinguish:

- Using an account privately for a specific approved operation.
- Reading mailbox contents into a model.
- Revealing a protected identity or credential field to an agent.
- Sending or changing data at an external service.

Connecting an account grants none of those automatically. Ask-first is the default. A standing or scheduled grant must pin the account, principal, operation allowlist, instruction revision, and lifetime. A disclosure grant must additionally bind the exact fields and request; it cannot follow a model's arbitrary request to decrypt another item. Writes and sends require their own approval policy.

For protected operations, the backend sends credentials only to the service that needs them. Never hand the model a decrypt tool or treat an opaque reference as authorization by itself. If a future operation discloses free-form external content to a model, it needs distinct user consent: regex masking cannot guarantee that a subject, body or attachment contains no sensitive information.

## Hard limit: full-access same-user agents

This PIN is not unbypassable against an unrestricted host process. Such a process can potentially read the user's OS keyring, modify the AppImage or source, inspect memory or the UI, read already delivered files, or alter the policy files. A server-side PIN check does not remove those OS privileges. This code has not received an independent security audit.

Strong isolation requires moving agents out of the owner's trust boundary: separate OS identity or a constrained sandbox, no owner home or keyring bus, no broker or application code writes, no owner desktop automation, and a narrow authenticated broker interface. The broker and its credentials must be owned outside the agent identity. Hardware-backed user presence may be appropriate for high-risk approvals. Do not claim Nod-equivalent isolation until that deployment and its bypass tests actually exist.

## Verification

Tests exercise first-setup identity, malformed and weak PINs, no plaintext PIN persistence, missing and incorrect PINs, persistent cooldown, changes requiring the old PIN, corrupt-policy failure, failed-write non-escalation, ask-first defaults, allow-mode disclosure step-up, raw-reference bypass refusal, origin binding, policy-epoch revocation, and explicit command consent. Browser tests exercise setup, non-owner refusal, masked PIN fields, disabled approvals without a PIN, and the separate disclosure checkbox.

These tests establish specific application behavior. They do not prove that a real mailbox connector is deployed, that same-user malware is isolated, or that every provider response is private.
