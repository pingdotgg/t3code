# Thread Deep Links

On macOS and Linux, the desktop app registers the `t3code://` URL scheme, so other tools can link straight to a thread:

```
t3code://threads/<environmentId>/<threadId>
```

Opening a link takes you to that thread and focuses its window once the app is ready. If you are on a setup, pairing, or connection screen, the newest link waits until you return to the app. If you are already looking at the thread, nothing changes.

The `t3code://app/<environmentId>/<threadId>` form is also accepted. Windows installers do not register the scheme. The environment id must be a UUID — aliases like `primary` are not accepted. A link that does not match the format exactly does not navigate. The operating system may still launch the desktop app before the link is checked.

This is handy for anything that records which thread produced a result: a notification, a log line, or a message can carry a link that drops you back into the conversation.
