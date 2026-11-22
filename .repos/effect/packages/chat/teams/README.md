# @effect/chat-teams

A [Microsoft Teams](https://www.microsoft.com/microsoft-teams) adapter for `effect/chat`, over the Bot Framework Connector. It includes the messaging endpoint, a pure activity normaliser, and the address helpers.

Nothing in this package has run against a real tenant yet, the default capabilities included. It is released ahead of that testing, which is follow-up work: the checks under [Live checks](#live-checks) list what is still to verify. Until a check passes, treat what it covers as unverified.

## Setup

One layer serves one Entra tenant through a single-tenant Azure Bot registration:

1. Register an app in Entra ID and create a client secret, or use a certificate or managed identity through a credentials provider.
2. Create an Azure Bot resource of type single-tenant with that app id, turn on the Microsoft Teams channel, and point its messaging endpoint at the route given to `TeamsChat.layerWebhook`.
3. Install the bot's app package in the tenant.

```ts
import * as TeamsChat from "@effect/chat-teams/TeamsChat"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"

const Teams = TeamsChat.layerWebhook({ path: "/api/messages" }).pipe(
  Layer.provideMerge(TeamsChat.layer({
    appId: "<app id>",
    tenantId: "<tenant id>",
    credentials: Redacted.make("<client secret>")
  }))
)
```

`TeamsChat.layer` needs `HttpClient`, the chat `Registry`, `Mac` and `Digest`. `TeamsChat.layerWebhook` needs `HttpRouter`, a `ChatHandler`, `HttpClient` and `Signature`. The adapter never calls `crypto.subtle` itself. Importing Bot Framework's public keys goes through `Jwk.importPublic`, which needs a `WebCrypto` reference whatever backend provides `Signature`.

The `HttpClient` must add no credentials of its own and follow no redirects. The adapter decides per request which host gets the bot's token, asks Fetch for `redirect: "manual"`, and fails a response that came from another URL than the one it sent to. With a client other than `FetchHttpClient`, or middleware that rewrites requests, keep both properties.

The cloud's endpoints and host allowlists come from `TeamsChat.publicCloud` or a `Cloud` of your own. They are configuration and are never read from an activity.

## Capabilities

Every capability below is unverified against a tenant. They fall in three groups.

**On by default:** `post`, `edit`, `delete`, `getThread` and `getUser`. `getUser` needs `in`, the thread whose roster to read.

**Implemented, off by default.** Turn these on with the `unverified` option, at your own risk. Turning one on advertises a capability no tenant has confirmed:

| Option        | Turns on                                    | Also needs        |
| ------------- | ------------------------------------------- | ----------------- |
| `buttons`     | `buttons` (buttons and link buttons)        | `interactionKeys` |
| `modals`      | `modals`, `modalErrors` (dialogs)           | `buttons`         |
| `commands`    | `commands`, `ephemeral` (targeted messages) |                   |
| `startThread` | `startThread`                               |                   |
| `download`    | `download`                                  |                   |

A dialog opens only from a button whose id is listed in `modalButtons`. Any other `OpenModal` is refused as `Unsupported`.

**Not implemented in this version.** These are `Unsupported` whatever the options:

- `fetchMessage`, `history` and `opener`. They need Microsoft Graph, which is deferred.
- `replyTo` (quoted replies).
- Files: `filesPerMessage` is 0, and the size reservation holds nothing for them.
- Native streams. Streams are posted and then edited.
- Selects.

The element caps are the adapter's own, since Teams publishes none: 6 elements per message and 10 fields per modal. `actionDataLength` (1,000) and `modalMetadataLength` (4,000) count the whole signed token that carries the data, envelope included. With a GUID app and tenant that leaves about 500 ASCII characters for a button's id and value. A dialog token also carries the modal's definition, so its id, metadata, title, labels, options and texts share about 1,880 bytes of JSON. A modal over that is refused `TooLarge` before anything opens. Check 13 may raise the cap once the dialog card's real size limit is known.

## Security

- Inbound requests need a Bot Framework token: RS256, with a key endorsed for `msteams`, the cloud's issuer, the app id as audience, and a `serviceurl` claim equal to the activity's `serviceUrl`. The channel must be `msteams` and the tenant the configured one. Anything else is answered 403. The OpenID metadata and the key set are fetched with redirects off. Metadata over 64 KiB, or with a `jwks_uri` that is not a URL, is answered 503.
- The bot's token goes only to a Connector host from the cloud's allowlist, over `https:` on the default port. A download sends it only when the first URL is on its own class's allowlist. `redirectHosts` admits a host as a redirect target, never as the first hop, and a redirect hop gets no token.
- Button and dialog tokens are signed (HS256) and bound to the app, the tenant and the conversation. They are not encrypted: anyone who sees a card can read a button's id and value, and a modal's metadata. Do not put secrets in them.
- Button tokens have no replay protection. A click can be sent again for as long as the conversation exists. Dialog tokens also bind the user and the exact conversation id of the click, and expire after an hour. Signing does not stop a submit from arriving twice, so handlers still authorise and stay idempotent.
- A command's private answer goes as a targeted message to the user who sent the command. If that fails, the answer is not posted in public.

## Live checks

None of these has run. They are follow-up work, not a condition of publication, and need a Microsoft 365 developer tenant, an Azure Bot resource and a public tunnel to the endpoint. Each check covers only what it names. A failed check removes that capability, or, for the base, needs a fix in the adapter.

| Gate                                             | Checks                                                                                                                              | If a check fails                                                                                                           |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Base: `post`, `edit`, `delete`, events, user ids | 1, 12, 4, 8, 9, 10, 16, 7, 18                                                                                                       | A fix in the adapter. Check 4 failing for an op brings in a `serviceUrl` resolver. Check 10 failing changes the docs only. |
| `startThread`                                    | 12                                                                                                                                  | Absent                                                                                                                     |
| `buttons`                                        | 1, 9, 2, 3                                                                                                                          | Absent, or absent from private answers only                                                                                |
| `modals`                                         | 17, the `task/fetch` and `task/submit` envelopes, the older-client fallback, `Ack` on a declared button leaving nothing open, 2, 13 | Absent                                                                                                                     |
| `modalErrors`                                    | 13                                                                                                                                  | Absent: `Errors` then closes the dialog and sends a private message                                                        |
| `commands`, `ephemeral`                          | 3, 4                                                                                                                                | Absent. Targeted activities are still classified first and never reach anything public.                                    |
| Native streams                                   | 5, 4                                                                                                                                | Stays absent, so post-then-edit                                                                                            |
| `replyTo`                                        | 14                                                                                                                                  | Stays absent                                                                                                               |
| Files                                            | 1, and the attachment header limits Teams accepts                                                                                   | Stay absent                                                                                                                |
| `download`                                       | 18                                                                                                                                  | Absent                                                                                                                     |
| Reaction events                                  | 11                                                                                                                                  | Unknown types pass through as the raw string                                                                               |
| Graph reads                                      | 6, and history ordering                                                                                                             | Deferred                                                                                                                   |
| Selects                                          | 15                                                                                                                                  | Not in v1, so it gates nothing                                                                                             |

The checks:

1. The text form and the card form each arrive as one message with an id that `PUT` can edit, and `PUT` can switch between them. For files, an attachments-only activity with a card and images is one message.
2. The deadline for `adaptiveCard/action`, `task/fetch` and `task/submit` answers, and the failure answer that shows nothing unsafe.
3. The wire shape of a slash command in each scope: a leading slash or not, where the targeted flag appears (expected `recipient.isTargeted`), whether personal chats show the slash menu, no public fallback on failure, no Prompt Preview on a public answer, and a click on a private answer making no public activity.
4. Edit, delete, streaming and targeted sends all work through the global `serviceUrl`, and a targeted send works through the inbound `serviceUrl`.
5. Streaming over raw REST in group chats and channels, with a stored `replyTo` after the inbound request has returned, and a second stream answering the same message after a rotation.
6. Whether the Connector's activity id equals the Graph message id, and the Graph chat id of a personal bot chat.
7. Member lookup, targeted recipients and mention entities accept an Entra object id.
8. How `<`, `&` and `$` are escaped in `extendedmarkdown`, and whether bot messages unfurl links.
9. The real size edge for text and for cards. It sets `Edge` and the reservation `R`, and may only raise a term.
10. Whether a non-2xx answer is redelivered, and whether a retry keeps the activity id.
11. Reaction `type` strings beyond the six documented ones.
12. Which route makes a new top-level channel post and returns its id, and that the id is the reply chain's root.
13. Whether `ContinueTask` re-renders the dialog in place, where the errors show, and the size cap of a dialog card.
14. Quoted replies over raw REST in channels and group chats.
15. That `Input.ChoiceSet` has no submit-on-change in current Teams clients.
16. The issuer, audience and endorsements on inbound tokens for a single-tenant registration.
17. Whether an `adaptiveCard/action` answer can carry a task continuation that opens a dialog. If it can, `modalButtons` goes away.
18. The hosts actually seen for `serviceUrl`, image `contentUrl` and `downloadUrl` in each cloud and scope, and their redirect chains. These are written into the cloud presets. Nothing is added at runtime.

## Links

- [Website](https://effect.website): documentation, guides, and news.
- [Discord](https://discord.gg/effect-ts): ask questions, share what you're building, and talk to the core team.
- [Issues](https://github.com/Effect-TS/effect/issues): bug reports and feature requests.
