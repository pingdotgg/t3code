# Desktop operating model

## Current model

The desktop product remains native T3. Auldric does not own its shell, provider/session lifecycle,
pairing, connection handling, authentication, Git, terminal, preview, settings, updater, or Dev
interaction modes.

## Marketing composition boundary

Issue #4 uses the web client's structurally reserved route and root-layout composition point as the
explicit product-domain seam, separate from T3 interaction modes:

```text
dev       -> native T3 behaviour
marketing -> isolated Auldric Marketing requirements and workspace
```

Missing or unknown domain selects Dev. Entry and exit must be explicit and reversible. Returning to
Dev clears Marketing context, evidence, workspace selection, and authority from later turns.

The current lazy payload is only the tested boundary placeholder. Issue #21 owns the responsive
shell and visible switch; later Marketing issues own domain data and actions. Desktop inherits the
same case-sensitive parent, catch-all ownership, and safe pairing return through its existing web
renderer and hash history without changing its runtime identity.

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

The route boundary is current. The Marketing journey remains planned until each owning issue closes
with integrated proof.
