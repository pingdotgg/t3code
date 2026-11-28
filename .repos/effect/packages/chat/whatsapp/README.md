# @effect/chat-whatsapp

A [WhatsApp Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api) adapter for `effect/chat`, for one business phone number. Includes the webhook, a pure normaliser for your own transport, a minimal Graph API client, delivery keys, template messages and read receipts.

## Installation

```sh
npm install effect @effect/chat-whatsapp
```

## Signature verification

`WhatsAppChat.layerWebhook` requires the `Mac` service; the adapter does not
provide a default. Supply `NodeCrypto.layerMac` from
`@effect/platform-node/NodeCrypto`, `BunCrypto.layerMac`,
`DenoCrypto.layerMac`, or `BrowserCrypto.layerMac` from the corresponding
platform package.

For other runtimes such as Workers, provide
`Mac.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto))`.

## Known limits

- Groups are not supported. Group webhooks are logged and dropped, and an op on a group address fails.
- WhatsApp has no edit or delete, so a streamed reply is posted part by part.
- Outside the 24 hour customer service window only templates can be sent, with `WhatsAppChat.sendTemplate`.
- A user can tap more than one reply button of a message, or pick one list row twice. Each tap is its own click.

## Live checks

Checked on Graph API `v23.0` from a Meta test number to one phone. The default `baseUrl` is `v24.0`, where these have not been repeated.

- Meta counts text bodies, interactive bodies, reply button titles, list row titles and row ids in code points. The adapter counts UTF-16 units, which is never less. Captions, the list button and section titles were not measured. A reply button id is counted in UTF-8 bytes, up to 256, and the adapter checks it that way.
- The rendered formatting displays as intended, and literal `*`, `_` and escapes display as typed.
- A `.md` file sent as `text/plain` arrives with its name.
- A media header beside reply buttons or a link button renders.
- Meta gave up on a webhook response after about 22 seconds. The default `deadline` is 10 seconds.
- Six messages to one user in 4.4 seconds were accepted. That is one burst, not a sustained rate, so `minWriteInterval` stays at Meta's documented 6 seconds.

Not yet checked:

- Whether error 131047 comes back on the send or as a later status.
- Sending to a BSUID from a production number. A test number only sends to its allow-listed phone numbers.
- Sending from a production number whose business has Messaging accounts and a payment method, with and without `messagingAccountId`.
- Groups.

## Links

- [Website](https://effect.website): documentation, guides, and news.
- [Reference](https://effect.website/docs/v4/api/chat-whatsapp): API documentation for this package.
- [Discord](https://discord.gg/effect-ts): ask questions, share what you're building, and talk to the core team.
- [Community](https://effect.website/community-hub): meetups and events, or bring Effect to your own.
- [Issues](https://github.com/Effect-TS/effect/issues): bug reports and feature requests.

## Let's talk

Whether your team is considering Effect, rolling it out, or already running it in production, we'd love to hear from you: what you're building, what works, and what you need from Effect next.

- **Talk to the maintainers.** Introduce your team on [Discord](https://discord.gg/effect-ts) or email [contact@effectful.co](mailto:contact@effectful.co). We're happy to connect privately on Slack or Discord for feedback and help with adoption.
- **Production support.** We're exploring how to better support teams running Effect in production. If your organization has specific support needs, let's discuss them.
- **Adoption help.** Our [adoption partners](https://effect.website/adoption-partners) offer implementation, consulting, team extension, training, and commercial support.
