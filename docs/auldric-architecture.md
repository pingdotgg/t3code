# Auldric Marketing architecture

## Decision

T3 is the platform. Auldric is an isolated Marketing/Strategy domain composed through supported T3
seams. The legacy Auldric runtime is not an architectural base and must not be merged, replayed, or
used to resolve a conflict in Auldric's favour.

The decisional capability classifications and permitted repository actions live in
[the authority and module-boundary RFC](./auldric-system/13-upstream-authority-and-module-boundaries.md).
This architecture description does not independently authorize a registry, composition mechanism,
or implementation slice.

## Ownership model

```text
T3 platform
  authentication, actors, conversations, providers, sessions, transport,
  Dev modes/tools, shell, Git, terminal, preview, Connect, remote, CI, release
        |
        | supported explicit extension seam
        v
Auldric Marketing domain
  workspace binding, sources/evidence, Day 0, Marketing Strategy/GTM,
  canonical artifacts/revisions, decisions/reviews, approved Dev briefs
```

The product domain is separate from T3 interaction modes. Dev is the safe default. Marketing is
entered explicitly, can be exited explicitly, and can fail or be disabled without changing Dev.
Issue #4 owns the seam decision and must park implementation if no supported seam exists.

## Dependency rules

- Marketing code depends on stable T3 contracts or public seams; T3 core does not depend on
  Marketing modules.
- No Marketing module loads on the Dev startup or turn path.
- T3 identifiers remain opaque. Marketing adds domain identities without renaming or reinterpreting
  runtime identities.
- Generic missing capability is proposed upstream or parked.
- Legacy donor code is rebuilt only after #14 classifies the requirement, data migration,
  authorization risk, target issue, seam, rollback, and proof.

## Data architecture target

The verified T3 actor maps to a Marketing membership and role. Canonical customer sources, context,
packets, plans, artifacts, revisions, decisions, and reviews live in the correct organization's
physical workspace database. Central services retain only bounded catalogs, routing, entitlement,
and compatibility projections. Internal docs and other organizations are never fallbacks.

Canonical writes use expected versions, immutable revisions, idempotency, and read-back. Views,
chat, dashboards, previews, and exports are projections. Cross-store work has explicit failure and
reconciliation semantics rather than two authorities.

## Integration sequence

1. #2 pins T3 and guards shared-core drift; #17 establishes this authority.
2. #14 classifies donor material.
3. #4 through #6 establish domain, identity, and authorization seams.
4. #8, #9, #11, and #18 establish persistence, evidence, provenance, and Day 0.
5. #19 adds typed workflows/artifacts; #7 adds bounded continuity.
6. #20 supplies the approved brief contract; #13's children supply UI.
7. #15 proves the full journey and native Dev invariance.

Architecture completion requires targeted boundary tests plus canonical read-back, organization
isolation, failure-state, and integrated Dev-invariance proof. A document or donor implementation is
never that proof.
