# T3-authored provider text must not say Goal

Intercepting a leading `/goal` is not enough. Provider CLIs may treat “slash goal”, a `/goal` buried in pasted text, or instruction-like “start a goal” as their own command. If that happens, Codex can run a native Goal beside T3’s loop.

We decided two filters. User text: strip and refuse command forms (`/goal`, “slash goal”, and obvious spoken equivalents); the English word “goal” in an Objective is allowed. T3-authored text sent into a Turn (Continuation instructions and any hidden provider prompt) must not use the word “goal” at all — it refers to the Objective, the contract, or the outcome.

T3 still does not call `thread/goal/*`.
