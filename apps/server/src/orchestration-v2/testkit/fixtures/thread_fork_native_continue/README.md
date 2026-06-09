# Native Fork Continuation Fixture

This fixture records a provider-native fork followed by two turns on the fork.
It verifies that:

1. The fork inherits conversation context from its source.
2. Context introduced on the fork remains available on later fork turns.
3. The final recall prompt does not contain either marker, so the response must
   come from provider conversation state.

Both `codex_transcript.ndjson` and `claude_transcript.ndjson` record the same
logical scenario using each provider's native thread or session mechanism.

## Conversation Graph

```text
Source provider thread
|
+-- Turn 1
|   User: remember source-marker-7Q9V
|   Assistant: source marker stored
|
`-- native fork after Turn 1
    |
    `-- Forked provider thread
        |
        +-- Turn 2
        |   User: remember fork-marker-2K4M
        |   Assistant: fork marker stored
        |
        `-- Turn 3
            User: recall both markers without restating them
            Assistant: source-marker-7Q9V|fork-marker-2K4M
```

## Assertions

- The fork has a native provider thread or session ID distinct from its source.
- Turn 3's user prompt contains neither opaque marker.
- Turn 3 returns the source marker first and the fork-local marker second.

The providers may add whitespace around `|`; replay assertions normalize that
formatting before comparing the semantic result.

## Scope

This is a provider-capability fixture. It proves native fork inheritance and
continued fork context. It does not record or assert app-level merge-back
behavior.
