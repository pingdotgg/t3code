# ADR 009: Loopback Is Not an Authorization Boundary

## Status

Accepted, revising ADR 004.

## Threat

A listener bound to `127.0.0.1` can be reached by any local process. Browser content can also cause cross-origin requests to it even when CORS prevents reading the response. Possession of a loopback port therefore cannot authorize access to a remote environment.

## Evidence

The `run-tunnel-security-spike.mjs` probe loaded an unrelated page in Chromium and issued a `no-cors` request to another loopback port. The request reached the preview listener. The request did not include an `Origin` header, so origin-header validation alone would not reject it.

The same probe confirmed:

- local storage survives when the exact loopback authority remains stable;
- changing only the port creates a new origin and loses that storage;
- an absolute HTTPS redirect passes through unchanged and escapes the loopback authority.

## Decision

- Allocate one stable local authority per environment/project/target tuple for the lifetime of its origin grant.
- Treat the authority as a browser capability, not a random open port.
- The desktop browser host must restrict navigation to authorities granted to that browser session and prevent unrelated tabs from using preview authorities.
- Environment tunnel grants remain scoped to environment, session, target host, and target port, but server-side grants do not protect the desktop listener from local callers.
- Add a desktop-side connection broker that verifies the connecting browser guest belongs to the authorized session. A bare TCP listener without browser attribution is insufficient for the final design.
- Absolute redirects, OAuth callbacks, HTTPS upstreams, service workers, and configured public origins require explicit compatibility policy rather than a "no rewriting" guarantee.
- Replace one-WebSocket-per-TCP-stream before relay rollout unless load testing proves the relay limits acceptable. The target design is bounded multiplexing over dedicated authenticated tunnel connections.

## Open Implementation Choice

The browser-attribution mechanism needs a dedicated spike. Candidates include an Electron protocol/proxy integration, per-session proxy configuration, or another browser-mediated connection path that preserves ordinary application semantics while identifying the requesting guest. Port secrecy is explicitly rejected.
