# Merge-Back Continuation Fixture

This fixture records a native fork, a fork-local delta, and an app-style
merge-back handoff consumed by the original provider thread. A later source
turn recalls both markers without receiving either marker in its prompt.

Both provider transcripts execute the same graph.

## Conversation Graph

```text
Source provider thread
|
+-- Turn 1
|   User: remember merge-source-4H8Q
|   Assistant: merge source stored
|
+-- native fork
|   |
|   `-- Forked provider thread
|       `-- Turn 2
|           User: remember merge-fork-7T2W
|           Assistant: merge fork stored
|
`-- original source provider thread
    |
    +-- Turn 3
    |   App input: merge_back handoff containing merge-fork-7T2W
    |   Assistant: merge delta stored
    |
    `-- Turn 4
        User: recall source and transferred markers without restating them
        Assistant: merge-source-4H8Q|merge-fork-7T2W
```

## Assertions

- The fork uses a different native provider thread or session.
- The handoff and recall turns continue the original source provider thread.
- The recall prompt contains neither marker.
- The final response recalls both source and transferred fork context.

The transcript records the provider-facing handoff format. The app-level
`thread.merge_back` command and context-transfer lifecycle remain covered by
the orchestrator integration tests.
