# T3 never drives a provider Goal API

Codex app-server already has `thread/goal/*`. Using it on Codex and the T3 loop elsewhere would mean two implementations, and calling both would double-continue. Native Goal state also dies with the subprocess.

We decided v1 uses the T3 Continuation loop for every provider, including Codex. T3 does not call `thread/goal/set|get|clear`.

Intercepting the `/goal` token is not enough. Provider CLIs may also treat spoken forms (“slash goal”, a leading `/goal` in pasted text, instruction-like “start a goal”) as their own command. Anything T3 sends into a Turn must not be something the CLI can read as “start your native Goal.” The exact language filter is a separate decision.
