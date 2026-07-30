# Desktop deep links

The desktop app can open an existing thread from another local application or automation:

```text
t3code://threads/<environmentId>/<threadId>
```

Percent-encode each identifier when it contains characters that are not safe in a URL path. The app
ignores malformed links and links for unsupported destinations.

On macOS, you can test a link from Terminal:

```bash
open "t3code://threads/<environmentId>/<threadId>"
```

T3 Code launches or comes to the foreground, then selects the requested thread. If the environment
or thread is unavailable, the normal thread routing fallback remains in effect.
