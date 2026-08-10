# Desktop operating model

## Current model

The desktop product remains native T3. Auldric does not own its shell, provider/session lifecycle,
pairing, connection handling, authentication, Git, terminal, preview, settings, updater, or Dev
interaction modes.

## Planned Marketing composition

Issue #4 must first approve a supported, explicit product-domain seam separate from T3 interaction
modes:

```text
dev       -> native T3 behaviour
marketing -> isolated Auldric Marketing requirements and workspace
```

Missing or unknown domain selects Dev. Entry and exit must be explicit and reversible. Returning to
Dev clears Marketing context, evidence, workspace selection, and authority from later turns.

The planned Marketing user journey is:

```text
sources -> Day 0 packet -> human route review -> Marketing Strategy or GTM
        -> child-first artifacts -> parent rollup -> Library review
        -> optional approved brief to native T3 Dev
```

Library is the durable Marketing home for sources and canonical outputs. T3 retains generic Work,
Loops, Runs, Dev inspectors, terminal, diff, preview, settings, conversation transport, and runtime
UI. The approved brief is a deliberate input artifact; it does not switch domains, create a branch,
mutate code, or override T3 instructions.

None of this planned Marketing composition is a current capability until the owning issues close
with integrated proof.
