# Authenticated external tools

This opt-in prototype uses `T3CODE_EXTERNAL_TOOL_TARGETS`, a JSON object keyed by target name.
Each entry has an `endpoint` and an `operations` array. Endpoints must use HTTPS or loopback HTTP,
without URL credentials, query strings or fragments. Invalid configuration disables the feature
with a generic host warning. With no targets there is no tool registration or approval-policy change.

The `external_tool` MCP interface accepts a target name, operation and optional arguments. It is
potentially destructive and open-world. Only active root Codex calls in full-access/default mode
qualify; fenced linked work, delegated threads, native children and unsupported providers fail
closed. The consumer owns application authorization; arguments are arbitrary untrusted data.
They never supply identity, endpoint, or authentication. The signed identity includes environment,
thread, provider instance, provider session, runtime/interaction mode and link origin.

A reverse form elicitation asks the trusted Codex adapter to attest the native thread and turn.
The one-use challenge is bound to the current provider session. Echoing `accept` cannot attest it.
The broker rechecks the live shell and credential before forwarding. Enabling this feature
changes full-access Codex approval from `never` to granular elicitation-only approval; ordinary
server forms retain the original policy. Codex-generated `mcp_tool_call` approval elicitations are
automatically accepted only for an active full-access/default turn whose original policy was
`never`. This preserves the tool calls `never` previously allowed while enabling host verification.
Codex forwards `_meta` from MCP servers, so a server can send the same metadata and have its own
empty form accepted. It learns nothing and gains no tool, but such a form is not evidence of user
consent. Other modes retain their original turn approval policy. Isolated live checks cover Codex
0.166.0; recheck new provider versions before rollout.

## Receiver authentication

There is no bearer file. On host startup the broker generates an Ed25519 key pair in memory and
logs its public SPKI PEM and key ID (hex SHA-256 of the PEM text) at Info, so `T3CODE_LOG_LEVEL`
above Info hides it. The private key is held in a closure, is not exported or persisted, and is not
put in provider environments. An operator must pin the public key out of band at each receiver
before enabling requests, and pin the new key after host restart. A receiver must never trust a key
supplied by an incoming request or auto-enrol a key.

The POST body is exact UTF-8 JSON with format `version: 1`, `target`, `operation`, `arguments`,
`identity`, UUID `requestId`, and millisecond `issuedAt`/`expiresAt` (30 seconds apart).
`x-t3-key-id` identifies the pinned key; `x-t3-signature` is its base64url Ed25519 signature over
the exact body bytes. One key signs for every target, so a receiver must require `target` to equal
its own configured name. It must also reject unknown format versions, verify the signature with its
pinned key, enforce its operation allowlist, reject future-issued/expired requests or validity
windows over 30 seconds, and atomically consume request IDs until their expiry before executing an
action. Use synchronized clocks and zero skew by default (`issuedAt <= now < expiresAt`); any
configured skew allowance must be bounded and also extend replay-ID retention. Signature validation
alone does not prevent replay. Business permissions remain the receiver's responsibility.

Redirects are disabled. Requests and responses are limited to 64 KiB; target execution plus response
reading has a 15-second deadline. Error bodies are not relayed to agents. The default context budget
is unchanged; opt-in users receive the additional tool schema.

## Trust boundary

The host process and receiver are trusted. This stops an MCP caller that holds only a provider
credential, or that can only read a file or environment variable, from producing a signed call.
It is not an isolation boundary against arbitrary same-user process inspection, debugging, code
injection, host configuration changes or receiver compromise. Those require OS isolation or a
separate trusted signer deployment.

Only full-access callers qualify, so every eligible agent is an unsandboxed process running as the
host OS user. The host cannot assume such a process leaves the host alone. A signature means this
broker's policy ran; it does not mean an uncompromised agent asked. Attestation is therefore not a
boundary against a determined same-user process. On Linux, such a process might write a forged
elicitation request to the provider's stdout through `/proc/<pid>/fd/1`, which would be cheaper than
reading host memory. That path is untested.

Re-pinning after every restart is a weak ceremony. A same-user agent can restart the host with
altered code or write a fake key line into the log the operator reads, and routine re-pinning makes
that easy to accept. Production use needs a key source the agent cannot write, preferably a stable
key in a separate trusted signer. The pin store must not be writable by the agent's OS user, so a
loopback receiver running as that user does not protect its pin.

The provider environment merge helper removes the target config from the environments it builds.
Spawns that also extend the host environment put it back, including ACP launches
(`AcpSessionRuntime` defaults `extendEnv` to true). The config holds no signing key or bearer, and
endpoints cannot carry credentials or query strings, but do not put secrets in endpoint paths.

Apply the independent credential-liveness and HTTP-session-ownership fixes before deployment.
Security coordination, maintainer scope approval and live-provider/eval verification remain required
before any public submission or production rollout.
