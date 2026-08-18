# Open a desktop thread from another tool

The T3 Code desktop app can open a specific thread from a link produced by another tool, such as a
control surface, editor integration, notification, or script.

Use this format with the environment and thread IDs from T3 Code:

```text
t3code://app/#/<environmentId>/<threadId>
```

For example:

```text
t3code://app/#/environment-123/thread-456
```

Opening the link brings the desktop app forward and navigates it to that thread. The link contains
only identifiers, never a pairing token or bearer token. It can therefore open threads only in an
environment that is already configured and authenticated in that desktop app.

Local desktop development builds use the separate `t3code-dev://app/#/...` scheme so they do not
intercept links intended for a released desktop app.
