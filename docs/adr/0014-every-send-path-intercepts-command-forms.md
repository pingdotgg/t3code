# Every send path intercepts; the server refuses command forms

A Goal loop on the server is not enough if any composer can still `thread.turn.start` with `/goal …`. Mobile today has no send-path intercept. An old or thin client would leak command forms into Codex and start a native Goal T3 cannot see.

We decided v1 intercepts on every client that can start a Turn: web, desktop, and mobile. Chip UI may be thinner on mobile; intercept, Pause-on-Stop, and Goal state are required.

The server is backup: it refuses `thread.turn.start` whose user text is a Goal command form. It does not forward that text to a provider, and it does not parse the string into a Goal. Setting a Goal is `thread.goal.set`, not magic prompt text.
