# @effect/chat-slack

A [Slack](https://slack.com) adapter for `effect/chat`. Includes the Events API webhook, a pure event normaliser for Socket Mode or your own transport, a minimal Web API client, native streaming replies with the agent stop button, and the Slack emoji table.

## Installation

```sh
npm install effect @effect/chat-slack
```

## Signature verification

`SlackChat.layerWebhook` and `SlackChat.layerInteractivity` require the
`Mac` service; the adapter does not provide a default. Supply
`NodeCrypto.layerMac` from `@effect/platform-node/NodeCrypto`,
`BunCrypto.layerMac`, `DenoCrypto.layerMac`, or `BrowserCrypto.layerMac`
from the corresponding platform package.

For other runtimes such as Workers, provide
`Mac.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto))`,
using `effect/crypto/Mac`, `effect/Layer`, and `effect/crypto/SecureRandom`.
Pass the chosen layer to each route layer with `Layer.provide`.

An invalid signing secret fails layer construction as a defect. A verification
error or malformed signature fails closed with HTTP 401. Requests must still
have a digits-only timestamp within five minutes of the current clock.

## Known limits

- A post with files has not been tested in a Slack Connect channel.
- A post with files uploads the files, posts the message, then attaches the files to it. If Slack refuses the attach, the adapter deletes the message. A mention in that message can still notify before the delete, for a message that then disappears. With `ChatMarkdown`'s `unattachedNote`, the reply is posted again without the files, so the mention can notify twice.

## Links

- [Website](https://effect.website): documentation, guides, and news.
- [Reference](https://effect.website/docs/v4/api/chat-slack): API documentation for this package.
- [Discord](https://discord.gg/effect-ts): ask questions, share what you're building, and talk to the core team.
- [Community](https://effect.website/community-hub): meetups and events, or bring Effect to your own.
- [Issues](https://github.com/Effect-TS/effect/issues): bug reports and feature requests.

## Let's talk

Whether your team is considering Effect, rolling it out, or already running it in production, we'd love to hear from you: what you're building, what works, and what you need from Effect next.

- **Talk to the maintainers.** Introduce your team on [Discord](https://discord.gg/effect-ts) or email [contact@effectful.co](mailto:contact@effectful.co). We're happy to connect privately on Slack or Discord for feedback and help with adoption.
- **Production support.** We're exploring how to better support teams running Effect in production. If your organization has specific support needs, let's discuss them.
- **Adoption help.** Our [adoption partners](https://effect.website/adoption-partners) offer implementation, consulting, team extension, training, and commercial support.
