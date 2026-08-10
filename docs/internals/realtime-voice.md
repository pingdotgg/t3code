# Realtime Voice Server Boundary

> For maintainers. This documents the server foundation; it does not imply that a voice UI or
> audio transport has shipped on every client.

T3 keeps the environment's OpenAI API key on the host. An authenticated client asks its connected
environment for a short-lived Realtime client secret, then connects to OpenAI directly over
WebRTC. The T3 server does not proxy microphone or speaker media.

```text
web, desktop, or mobile client
  -> authenticated T3 environment HTTP endpoint
  -> OpenAI client-secret endpoint (server API key)
  -> short-lived client secret returned to the client
  -> direct client-to-OpenAI WebRTC session
```

This split preserves local, LAN, Tailscale, and T3 Connect operation because the request uses the
same environment HTTP origin, cookie/Bearer/DPoP authentication, and remote URL preparation as the
rest of the client runtime.

## Environment API

The `realtimeVoice` environment capability advertises this boundary. Older environments omit the
flag, so clients must not probe these endpoints when it is absent.

| Method | Path                                | Required scope          | Result                                                                                     |
| ------ | ----------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------ |
| `GET`  | `/api/voice/openai/credential`      | `access:write`          | Whether a key is configured and whether it comes from stored state or the host environment |
| `POST` | `/api/voice/openai/credential`      | `access:write`          | Typed `set` or `remove` action followed by the new status                                  |
| `POST` | `/api/voice/realtime/client-secret` | `orchestration:operate` | A short-lived client secret, expiration timestamp, and Realtime session ID                 |

Credential status never returns the key. Removing stored state is an explicit reverse operation;
if `OPENAI_API_KEY` is present, the environment fallback becomes active again.

Every response under `/api/voice/` uses `Cache-Control: no-store` and `Pragma: no-cache`, including
authentication and request-decoding failures. Rate-limit responses also include `Retry-After`.

## Credential Resolution

`OpenAiRealtimeCredential` owns one fixed `ServerSecretStore` key. Stored state takes precedence
over the optional `OPENAI_API_KEY` process setting. Both inputs are trimmed and bounded before use;
invalid stored or environment values fail closed. The fixed-key store retains the existing
directory and file permission guarantees rather than adding a second settings or encryption path.

The main API key remains redacted inside the adapter and is used only to construct the upstream
authorization header. Public status, success, and error schemas contain no API-key field.

## OpenAI Adapter

The upstream boundary is intentionally narrow:

- origin: `https://api.openai.com`
- endpoint: `POST /v1/realtime/client_secrets`
- model: `gpt-realtime-2.1`
- client-secret TTL: 60 seconds
- default voice: `marin`
- allowed voices: `alloy`, `ash`, `ballad`, `coral`, `echo`, `sage`, `shimmer`, `verse`, `marin`, and `cedar`

The server derives a stable, non-PII identifier by hashing its persisted environment ID with a
domain separator and sends it as `OpenAI-Safety-Identifier`. OpenAI binds that server-supplied
identifier to the resulting ephemeral token. See the official
[Realtime WebRTC authentication guide](https://developers.openai.com/api/docs/guides/realtime-webrtc#connecting-using-an-ephemeral-token)
and [client-secret API reference](https://developers.openai.com/api/reference/resources/realtime/subresources/client_secrets/methods/create).

OpenAI client secrets may be reused until expiry, and the client can override their attached
session defaults. T3 clients therefore keep the same model and voice allowlist when they establish
the WebRTC session; the server limits issuance but cannot treat mint limits as a hard session or
spend cap.

The adapter performs one request with a ten-second timeout and no retry. It decodes only the
declared success fields and requires the returned expiration to fit the requested TTL plus thirty
seconds of clock and network skew. It never reads or logs an upstream error body. Transport and
decode causes are replaced with stable tagged errors before they reach environment request
logging.

## Local Backpressure

Client-secret minting uses bounded, process-local protection:

- six requests per authenticated session per minute;
- thirty requests across the process per minute;
- four concurrent upstream requests.

The per-session tracker retains at most 256 session IDs and expires idle entries after two
minutes, so session churn cannot grow process memory without bound. These limits reset with the
server process and are not intended to coordinate multiple hosts.
OpenAI `429` responses retain a bounded `Retry-After` value; local rate and concurrency rejection
use the same typed environment error shape.

## Public Failure Model

Clients receive only stable categories:

- unavailable: no credential, rejected credential, or unavailable model;
- rate limited: local request rate, local concurrency, or upstream rate;
- upstream failure: request failure, upstream outage, or invalid response;
- timeout;
- internal environment failure for secret-store, safety-identifier, or limiter faults.

Raw provider messages, response bodies, authorization headers, and stored secret values are not
part of these errors.
