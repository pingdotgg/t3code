# Repeated Sibling Merge-Back Fixture

This fixture records two independent native forks from one source turn, then
feeds both fork deltas back into the original provider thread in sequence. A
later source turn must recall all transferred context.

Both provider transcripts execute the same graph.

## Conversation Graph

```text
Source provider thread
|
`-- Turn 1: remember merge-sibling-source-3C7K
    |
    +-- native fork A
    |   `-- Turn 2A: remember merge-sibling-first-6V2J
    |
    `-- native fork B
        `-- Turn 2B: remember merge-sibling-second-9X5B

Original source provider thread
|
+-- Turn 3: consume merge-back handoff from fork A
|   `-- Assistant: first merge delta stored
|
+-- Turn 4: consume merge-back handoff from fork B
|   `-- Assistant: second merge delta stored
|
`-- Turn 5: recall all markers without restating them
    `-- merge-sibling-source-3C7K
        |merge-sibling-first-6V2J
        |merge-sibling-second-9X5B
```

## Assertions

- Both forks have distinct native provider thread or session IDs.
- Both handoffs resume the original source provider thread.
- The final recall prompt contains none of the three markers.
- The final response returns the source marker followed by both fork markers
  in merge order.

This proves repeated handoffs accumulate provider context. The app-level
transfer records, merge ordering, and source/fork projections remain
orchestrator responsibilities.
