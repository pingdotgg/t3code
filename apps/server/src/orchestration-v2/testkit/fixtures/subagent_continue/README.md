# Continued Native Subagent

This fixture records Codex continuing a native subagent from a later parent turn.

```text
Parent app thread / Codex thread A
  Turn 1: spawn one subagent
    |
    +-- spawnAgent
          |
          v
        Child app thread / Codex thread B
          Turn 1: initial prompt
          Assistant: initial subagent response

  Turn 2: @hooke continue the same subagent
    |
    +-- resumeAgent + sendInput
          |
          v
        Child app thread / Codex thread B
          Turn 2: continuation prompt
          Assistant: continued subagent response
```

The original parent `subagent` item represents only the spawn lifecycle. It must
remain completed with the first result while the child thread accumulates later
conversation turns.
