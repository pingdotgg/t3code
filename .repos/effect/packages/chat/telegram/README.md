# @effect/chat-telegram

A [Telegram](https://telegram.org) adapter for `effect/chat`, over the Bot API. It includes a webhook endpoint, a long-polling loop, a pure update normaliser, and the address helpers.

The live checks ran against production on 16 Nov 2026, and their results are below. Not verified: what a bystander sees of a command. Files, buttons and commands stay behind the `unverified` options.

## Setup

Create a bot with [@BotFather](https://t.me/BotFather) and keep its token. Pick one transport: a webhook, or polling for a long-running process. Telegram allows only one at a time.

```ts
import * as TelegramChat from "@effect/chat-telegram/TelegramChat"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"

const token = Redacted.make("<bot token>")
const secretToken = Redacted.make("<32 to 256 characters of A-Za-z0-9_->")

const Webhook = TelegramChat.layerWebhook({ path: "/telegram", secretToken }).pipe(
  Layer.provideMerge(TelegramChat.layer({ token }))
)

const Polling = TelegramChat.layerPolling().pipe(
  Layer.provideMerge(TelegramChat.layer({ token }))
)
```

`TelegramChat.layer` needs `HttpClient` and the chat `Registry`. `TelegramChat.layerWebhook` also needs `HttpRouter` and a `ChatHandler`, and `TelegramChat.layerPolling` a `ChatHandler`. Clicks and commands go to `ChatInteraction.Handler` when one is in context.

In a group, a bot in privacy mode receives commands, replies to its own messages and service messages, but not a plain `@bot` mention. To see mentions, turn privacy mode off in @BotFather or make the bot an admin.

Register the webhook once with `TelegramChat.setWebhook({ url, secretToken })`, which sets exactly the `allowed_updates` the adapter reads. The adapter never calls it, or `deleteWebhook`, on its own. Polling fails to start with `InvalidRequest` and detail `conflict` while a webhook is set.

`environment: "test"` uses Telegram's [test environment](https://core.telegram.org/bots/features#dedicated-test-environment). `apiUrl` points at a local Bot API server.

## Capabilities

By default the descriptor advertises `edit`, `delete`, `replyTo`, `download`, `getThread` and `getUser`, alongside `post`. Posts and edits are rich messages (`sendRichMessage`). `getUser` needs `in`, the chat to look the user up in.

These capabilities are implemented but stay off until their live checks pass, on top of the base checks. Turn them on with the `unverified` option, at your own risk:

| Option     | Turns on   | Live checks, besides the base ones |
| ---------- | ---------- | ---------------------------------- |
| `files`    | `files`    | 6                                  |
| `buttons`  | `buttons`  | 8                                  |
| `commands` | `commands` | 9                                  |

An edit of a message posted with files drops its media (live check 6).

Not supported in this version: `ephemeral`, `fetchMessage`, `history`, `opener`, `startThread`, selects, modals, native streams, reactions (outbound and as events), and typing. A private answer to a command is refused through `ChatInteraction.Handler.refused` with `Unsupported`, and is never posted in public. A `message_reaction` update goes to `onUnhandled`.

Updates from business connections, a channel's direct messages and guest mode are never dispatched: they go to `onUnhandled`. A business chat's button is answered so the client stops waiting.

## Security

- The bot token is in the URL path of every Bot API call. The adapter turns off the HTTP client's own spans for these calls, writes its own span with the path as `/bot<redacted>/{method}`, never follows a redirect, and keeps the token out of every error.
- The webhook needs the `X-Telegram-Bot-Api-Secret-Token` header, compared in constant time, before it reads the body. Server spans record no headers by default. An app that records them (`HttpMiddleware.TracerHeaderFilter`) must add `TelegramChat.secretHeader` to `Headers.CurrentRedactedNames`, keeping the names already there, in the layer it serves. `Layer.provide` on the webhook alone does not reach the server span, `Layer.provideMerge` does:

  ```ts
  import * as Effect from "effect/Effect"
  import * as Headers from "effect/http/Headers"

  const RedactSecret = Layer.effect(
    Headers.CurrentRedactedNames,
    Effect.gen(function*() {
      return [...yield* Headers.CurrentRedactedNames, TelegramChat.secretHeader]
    })
  )

  const App = Webhook.pipe(Layer.provideMerge(RedactSecret))
  ```
- Consumer Markdown is escaped so that it reaches no raw HTML, image, math, spoiler, highlight, or link outside `http`, `https` and `mailto`. A `tg://user` link stays only for users listed in `withPostOptions({ notify: { users } })`. Telegram honors only some backslash escapes, and it closes a link at an escaped `]`, so the other escapes become numeric character references, and a refused link or definition is broken at its `(` or its opening `[`. A kept link is sent with its destination verbatim, as Telegram reads it, and without its title. It is kept only when its `[` is on the same line, its label has no other bracket in it and no `]` comes right before it, and its destination has balanced parentheses at most three deep, the least CommonMark lets a parser support. A line whose first `[` meets a `]:` is kept as a definition only at the top level after a blank line, with a plain label that starts the line (no other bracket, code span, autolink or escaped `]`) and stays within 999 characters once escaped, and with nothing after its destination but a title. Otherwise its `[` is escaped.
- Where Markdown is ambiguous the escaping errs toward plain text: a table keeps its pipes only after a blank line or a heading; a `*` or `_` with space on both sides is escaped, as Telegram would open emphasis with it; and past 15 delimiters that could open emphasis, or 4,000 code spans, footnote references and `[` that could open a link or reference in one paragraph, or 700 footnote references in a message, the rest are shown as written. Telegram still pairs emphasis more loosely than CommonMark: `a* b*` is italic.
- A click is dispatched only when its `data` matches a button in Telegram's own copy of the message, and Telegram already refuses data that is not on the current keyboard (live check 8). Neither says that this user may press it.

## Redelivery

Telegram sends an update again until it gets a 200, clicks and commands included. Polling sees it again until the offset moves past it. The webhook answers 503 when the `ChatHandler` fails `NotAccepted` or passes `deadline` (10 seconds), and Telegram retries. Polling retries an update up to `maxAttempts` times, then logs it and moves on.

Telegram delivers webhook updates in order: while one is refused, the ones after it wait. This was seen in one chat. Whether updates for other chats wait too was not tried, so assume a refused update can stall every chat, and keep `NotAccepted` for short outages. Telegram retries after about 0.3, 2, 4, 8, 16 and 32 seconds, keeping the `update_id`, and gives up on a webhook request after 60 seconds.

Clicks and commands are different. Their handlers have a deadline of their own, and when it passes the update counts as answered: the webhook answers 200 and polling moves its offset. Telegram does not send it again.

- A click handler has `clickDeadline` (2.5 seconds). Then the click is answered so the button stops spinning, and the handler keeps running, detached. If it fails or the process dies after that, nothing repeats the click.
- A command handler has `commandDeadline` (10 seconds). Then it is interrupted. If it had not committed, the command is lost.
- A handler that fails, rather than passing its deadline, is answered and refused through `ChatInteraction.Handler.refused`, not redelivered.

A handler whose work must not be lost or done twice keys it with `TelegramChat.deliveryKey(event.raw, { botId })`. The adapter keeps no store, so this is the consumer's to do:

1. In one transaction, insert the key under a unique constraint, together with a work item that a worker picks up, also after a crash.
2. Return only after the commit: success from the `ChatHandler`, `Ack` for a click, `Defer` for a command. The worker does the work, and for a command sends the `followUp`.
3. When the insert hits the constraint, the work is already safe: answer the same way at once. A repeated command answers `Defer`, never `Ack`, which would turn it into `MessageCreated`.

A crash before the commit leaves nothing, and the repeat does the work. A concurrent repeat waits on the constraint for the first transaction. This holds only while the transaction commits within the deadline above: for clicks and commands a late commit is not repeated. External side effects, such as a payment, still need their own idempotency key (the delivery key works). Nothing here gives exactly-once effects.

## Live checks

Checks 1 to 16 ran on production on 16 Nov 2026, with a bot, a second non-admin bot, one person and a forum supergroup. That also covers check 17, except for check 9's bystander. `test/live.test.ts` runs the conformance suite against the Bot API only when all of `TELEGRAM_LIVE_BOT_TOKEN`, `TELEGRAM_LIVE_BOT2_TOKEN` and `TELEGRAM_LIVE_CHAT` are set, so CI skips it.

1. Rich messages render on macOS desktop and mobile clients. Not seen: Web, Android and older clients.
2. The rich-Markdown dialect, the escapes Telegram honors, and its readings of links, definitions and emphasis. The escaping follows what it found.
3. The limits: 32,768 rendered characters (non-ASCII text counts less), 500 blocks with a list counting one per item, 16 levels of nesting, 20 table columns, about 4,387 inline nodes per paragraph and about 773 references to one footnote. A code block is one block. `measure` stays under each of these.
4. No link preview on rich posts or edits.
5. A plain `@user` notifies nobody, and an allowed `tg://user` link is a mention.
6. Rich-message media over multipart `attach://`: up to 50 files in one message, 51 is refused with 413; 10 MB files; file names and MIME types kept, except that Telegram turns some characters outside Latin-1, such as `–`, into spaces. An edit drops the media. A download through the adapter is byte for byte.
7. Webhook redelivery after a 503 or a dropped connection, as described under Redelivery. Not run: the polling side, and whether a refused update holds back other chats.
8. Callback queries carry Telegram's copy of `reply_markup`, which an edit replaces. Telegram keeps at most 100 buttons and 8 per row, and drops the rest without an error. A click answered at the 2.5-second deadline stops spinning about 4 seconds after the tap. Telegram itself refuses, with `DATA_INVALID`, a click whose `data` is not on the message's current keyboard: forged, tampered, from another message, or from a keyboard an edit replaced. The adapter's own check is a second layer.
9. Commands, with the author only. A typed command and one picked from the menu arrive alike. In a group, a command registered with `is_ephemeral` arrives with `message_id` 0, an `ephemeral_message_id` and `receiver_user`, and goes only to the command handler; in a private chat it is an ordinary command. A private answer is refused with `Unsupported` and nothing is posted. A public follow-up within 15 seconds replies to the command, and later fails `NotFound` with `interaction_expired`. Not tried: a bystander.
10. The error responses behind the error mapping.
11. Forum topics and the General topic. Topics in private chats were not tried.
12. Reaction updates reach an admin bot that asks for `message_reaction`, which the adapter does not. Each carries the user's whole set before and after, as `old_reaction` and `new_reaction`: add, change and remove each give one update. They normalise to no event. Not tried: custom and paid emoji, and `actor_chat`.
13. Edit pacing: one edit every 3 seconds in a group gets no 429. Back-to-back edits got one after 19, with `retry_after` 43.
14. `getChatMember` as a non-admin works for members and non-members, and fails `NotFound` for another bot.
15. A plain `@bot` mention does not reach a bot in privacy mode. A reply does.
16. Inbound rich messages: a bot never receives another bot's messages, so they arrive only as a reply target, with `rich_message` and no `text`.
17. A production smoke check of 1, 4, 5, 9, 13 and 15: all ran, except check 9's bystander.

## Links

- [Website](https://effect.website): documentation, guides, and news.
- [Discord](https://discord.gg/effect-ts): ask questions, share what you're building, and talk to the core team.
- [Issues](https://github.com/Effect-TS/effect/issues): bug reports and feature requests.
