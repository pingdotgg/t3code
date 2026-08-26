# Thread Deep Links

The desktop app registers the `t3code://` URL scheme, so other tools can link straight to a thread:

```
t3code://app/<environmentId>/<threadId>
```

Opening a link focuses the app (launching it first if it is not running) and takes you to that thread, from whatever screen you were on. If you are already looking at the thread, nothing changes.

Both ids are UUIDs. A link that does not match the format exactly is ignored — nothing opens, nothing navigates.

This is handy for anything that records which thread produced a result: a notification, a log line, or a message can carry a link that drops you back into the conversation.
