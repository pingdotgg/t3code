# Marketing workflows and artifacts

This is the approved requirements checkpoint for issues #18 and #19, pending donor classification
under #14 and implementation through supported T3 seams.

## Canonical chain

```text
Marketing Source Library
-> workflow -> stage -> parent and child-step definitions
-> bounded action -> canonical artifact head and immutable revision
-> registered renderer -> review -> exact parent rollup
```

Backend-served definitions own keys, versions, source floors, schemas, artifact families, renderers,
and parent membership. Chat, previews, exports, and dashboards are projections and cannot overwrite a
canonical artifact. Required child artifacts must exist before a parent reports a complete
`stepArtifactRollup`.

## Day 0 contract

With useful commercial context, Day 0 produces:

- a direct point of view and one testable hypothesis with confidence and disconfirmation signals;
- two to four immediate actions with owner, output, completion point, and success signal;
- exactly one recommended Marketing Strategy or GTM route with rationale;
- the other route only as an explicit override;
- evidence, assumptions, gaps, sources, unresolved decisions, and pending review state.

A contextless workspace keeps the hypothesis and route pending and asks no more than three
decision-changing questions. A person must accept or override the route before activation. The
selected workflow—not Day 0—owns the durable 90-day plan and dashboard.

The first approved workflow scope is Marketing Strategy and GTM. Broader donor workflows remain
parked until #14 classifies them and an executable issue owns them.
