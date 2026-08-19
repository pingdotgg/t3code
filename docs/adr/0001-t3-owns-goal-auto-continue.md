# T3 owns Goal auto-continue

Codex already has a native goal runtime, and a sticky reminder (store the objective, still wait for the user) would have been a smaller change. We decided a Goal is a T3 completion contract: while it is active, orchestration starts the next Turn itself.

Provider-native goal APIs are not the source of truth. T3 must continue Claude, Cursor, Grok, and OpenCode the same way, and a subprocess crash or session reap must not forget the Goal.
