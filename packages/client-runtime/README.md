# Client Runtime

Shared client behavior for web and mobile. Public APIs are organized by package
subpath. The package intentionally has no root export.

## Public subpaths

| Subpath               | Responsibility                                                    |
| --------------------- | ----------------------------------------------------------------- |
| `authorization`       | Bearer and DPoP authorization plus token persistence contracts    |
| `connection`          | Targets, catalog, supervision, retries, registry, and onboarding  |
| `environment`         | Environment identity, descriptors, endpoints, and scoped keys     |
| `errors`              | Shared client error inspection                                    |
| `operations`          | Multi-step application workflows                                  |
| `operations/projects` | Multi-step project creation workflows                             |
| `platform`            | Platform capability and persistence service contracts             |
| `relay`               | Managed relay API and environment discovery                       |
| `rpc`                 | HTTP/RPC clients, protocol, sessions, and subscriptions           |
| `state/<domain>`      | Focused shared state, retention, reducers, and Atom constructors  |
| `voice-input`         | Recording lifecycle, transcription contracts, and draft insertion |

## Dependency direction

Platform applications provide `platform` services. `connection` composes those
capabilities with `authorization`, `relay`, and `rpc` to supervise environment
sessions. Independent `state` modules consume the connection registry and expose
focused state or Atom constructors to application-owned runtimes.

The `voice-input` controller accepts capture callbacks and a selected `VoiceTranscriber`.
Preparation binds transcription to its implementation and resolved locale; one cancellation
signal covers both operations. Applications provide recorder events, permissions, native
transcription implementations, and presentation.

Applications should import the narrowest relevant subpath. There is no broad
`state` export: use domain paths such as `state/shell`, `state/threads`,
`state/terminal`, or `state/vcs`. Subpath indices and explicitly exported domain
files are public API boundaries; all other files remain implementation details.
