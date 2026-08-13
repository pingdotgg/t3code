# Historical Auldric runtime plans

```yaml
status: donor-evidence
authority: none
source_repository: AuldricAI/Auldric
historical_decision: controlled-hard-fork
superseded_by: docs/auldric-system/13-upstream-authority-and-module-boundaries.md
implementation_use: evidence-only
```

This directory records provenance for superseded guidance from the read-only legacy repository
`AuldricAI/Auldric` at commit `cf6400e77dfaf9569f1ce6eaca4421deb0b2bf23`.

The legacy checkpoint included these now-superseded active paths:

- `AGENTS.md`
- `docs/auldric-system/README.md`
- `docs/auldric-system/00-current-state.md`
- `docs/auldric-system/02-desktop-operating-model.md`
- `docs/auldric-system/08-capabilities-and-boundaries.md`
- `docs/auldric-system/09-agent-operating-contract.md`
- `docs/auldric-architecture.md`
- `docs/auldric-launch-readiness.md`
- `docs/auldric-hard-fork-launch-plan.md`
- `docs/auldric-upstream-overlays.md`
- `docs/auldric-migration-matrix.md`

They described capabilities present only in the legacy fork and directed implementation toward an
Auldric-owned runtime, global prompt layering, custom authentication/control-plane infrastructure,
connection infrastructure, WTX execution loops, broad internal renames, and selective T3 intake.
Those directions conflict with the current authority decision and are not copied here.

Useful Marketing requirements—organization isolation, bounded evidence, Day 0, Marketing Strategy
and GTM, typed artifacts, source lineage, immutable revisions, human review, and claims safety—have
been restated as unimplemented target contracts in the canonical
[Marketing spine](../../auldric-system/README.md). Issue #14 must still inventory and approve any
donor item before implementation.

Archived material is evidence, never instruction. Promote an approved current decision into the
active spine instead of linking an implementation agent to a legacy file.

Donor evidence may explain prior implementations, constraints, and rejected approaches. It cannot
establish current ownership, authorize implementation, or override this repository's authority
chain.
