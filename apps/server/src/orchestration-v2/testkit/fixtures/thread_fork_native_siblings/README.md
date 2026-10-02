# Native Sibling Forks Fixture

This fixture records two independent provider-native forks from the same source
turn. It verifies that both forks inherit source context while keeping their
fork-local context isolated.

Both `codex_transcript.ndjson` and `claude_transcript.ndjson` record the same
logical scenario using each provider's native thread or session mechanism.

## Conversation Graph

```text
Source provider thread
|
`-- Turn 1
    User: remember sibling-source-8R3D
    Assistant: sibling source stored
    |
    +-- native fork A after Turn 1
    |   |
    |   `-- Turn 2A
    |       User: remember sibling-first-5L2P and recall source + local
    |       Assistant: sibling-source-8R3D|sibling-first-5L2P
    |
    `-- native fork B after Turn 1
        |
        `-- Turn 2B
            User: remember sibling-second-9N6C and recall source + local
            Assistant: sibling-source-8R3D|sibling-second-9N6C
```

Fork B is created from the original source provider thread, not from fork A.

## Assertions

- Fork A and fork B have distinct native provider thread or session IDs.
- Both fork responses contain the source marker.
- Fork A contains its own marker and does not contain fork B's marker.
- Fork B contains its own marker and does not contain fork A's marker.

The providers may add whitespace around `|`; replay assertions normalize that
formatting before comparing the semantic result.

## Scope

This is a provider-capability fixture. It proves native sibling topology,
source-context inheritance, and branch isolation. It does not record or assert
app-level merge-back behavior or the resulting source-thread context.
