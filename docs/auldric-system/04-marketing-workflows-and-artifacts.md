# Marketing workflows and artifacts

This is the approved requirements checkpoint for issues #18 and #19. Issue #14 approved the
bounded Marketing requirements for a fresh rebuild. The dependency-safe pure Day 0 kernel now
exists; persistence, review composition, workflow catalogs, activation, artifacts, and UI remain
pending through their owning issues and supported T3 seams.

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

## Implemented pure Day 0 boundary

The package-level `compileMarketingDay0` compiler consumes and verifies one exact #9 evidence packet
and receipt. Useful context produces the complete point-of-view, hypothesis, disconfirmation,
two-to-four action, and single-route recommendation contract. Contextless or unavailable-source
input keeps the point of view, hypothesis, and route pending, creates no immediate action, and keeps
at most three decision-changing questions. Both paths expose exact source/evidence references,
assumptions, conflicts, gaps, unresolved decisions, readiness, pending review, and a deterministic
receipt.

Marketing Strategy and GTM definitions/readiness are injected as versioned projections. The kernel
does not implement #19's catalog. Route accept/override preparation is explicit and expected-version
pinned, but remains `pending-canonical-save`; activation is always dormant. Therefore this boundary
does not yet claim durable Day 0 revisions, saved route review, workflow activation, a 90-day plan,
or a dashboard. #11 and #19 must provide their approved contracts before that composition can land.
