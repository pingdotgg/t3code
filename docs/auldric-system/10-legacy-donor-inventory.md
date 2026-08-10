# Legacy Auldric donor inventory decision

Issue #14 audits `AuldricAI/Auldric` at immutable commit
`cf6400e77dfaf9569f1ce6eaca4421deb0b2bf23`. The audit classifies donor evidence; it does not port
the donor implementation.

The complete record is
[`legacy-donor-inventory.json`](./legacy-donor-inventory.json). Its 76 ordered selectors resolve all
5,496 files in the donor tree exactly once. Each record includes the path/capability, class, legacy
evidence status, current Auldrics truth, owner/rationale, target issues, supported seam or upstream
dependency, migration/backfill/rollback, tenant/security risk, tests/proof, and final disposition.

## Audit method and evidence

- Donor commit: `cf6400e77dfaf9569f1ce6eaca4421deb0b2bf23`
- Root tree: `3a156d03c69b49523fef05ffc5f6700cff26252e`
- Donor files: 5,496
- Ordered rule: first matching selector owns the path, so an item receives one class
- Path-list SHA-256: `3fae0c683f267f7008606170310cc9c5a390f4afaad0ca50039d075c5630041b`
- Full `git ls-tree -r` SHA-256:
  `f517c00133e282cbe422bad6e634704dc43e8d158d47063495bb9bbf9068c8a5`

Verify the record against a read-only checkout containing the exact commit:

```bash
node scripts/auldric/check-legacy-donor-inventory.ts \
  --donor-repo /absolute/path/to/read-only/Auldric
```

The validator rejects a different commit/tree, changed file list, incomplete record, empty selector,
duplicate record ID, invalid class/disposition, or unclassified donor path.

| Class               | Records | Donor files | Meaning                                                      |
| ------------------- | ------: | ----------: | ------------------------------------------------------------ |
| Keep/rebuild        |      14 |         908 | Marketing requirement evidence eligible for a fresh rebuild  |
| Split               |      16 |         306 | Mixed item; only the named Marketing requirement may survive |
| Replace with T3     |      17 |       1,581 | Current native T3 implementation and identity win            |
| Retire              |      14 |         455 | Duplicate runtime, generic work, or obsolete fork behavior   |
| Upstream dependency |       5 |          44 | Parked until T3 owns a supported generic seam                |
| Historical evidence |      10 |       2,202 | Plans, migrations, reports, screenshots, assets, and proofs  |
| **Total**           |  **76** |   **5,496** | Complete donor tree                                          |

Final dispositions are also explicit in the machine record: 6 retain, 16 split, 13 rebuild, 17
replace, 10 archive, and 14 delete decisions. “Delete” means do not reproduce the donor item in this
repository; no file or history is deleted from the read-only donor.

## Current truth versus legacy completion

The donor contains implemented routes, schemas, migrations, UIs, tests, completed plans, reports,
and screenshots. Those facts establish historical evidence only. Current Auldrics started from the
pinned native T3 baseline and, at this decision, has no Marketing data layer, evidence compiler,
Day 0 kernel, Strategy/GTM catalog, artifact Library, review system, or approved Dev handoff. The
current [state checkpoint](./00-current-state.md) and owning issue proof decide when that changes.

A donor test proves what the donor did. It does not prove that current Auldrics implements the
capability, that the donor architecture is supported, or that old customer/credential/runtime state
can be migrated.

## Keep/rebuild

These records approve the bounded Marketing requirement for fresh implementation. They do not
approve copying files, migrations, framework structure, or history.

- `public-marketing-content-and-assets`
- `console-marketing-artifact-workflow-and-brand-domain`
- `web-day0-evidence-and-source-ui`
- `web-artifact-library-and-presentation-ui`
- `web-strategy-workflow-and-shell-ui`
- `web-production-marketing-components`
- `server-marketing-evidence-and-artifacts`
- `contracts-pure-marketing-domain`
- `database-marketing-content-and-workflows`
- `shared-pure-marketing-logic`
- `marketing-benchmark-package`
- `mcp-marketing-runbook-requirements`
- `donor-marketing-requirement-documents`
- `marketing-copy-and-brand-validation-scripts`

The accepted scope is limited to Marketing sources/evidence, Day 0, Marketing Strategy and GTM,
typed artifacts and renderers, brand/copy/claims requirements, decisions/reviews, and the separately
owned public surface. Each record names its current target issues and test obligations.

## Split before implementation

These modules mix eligible Marketing requirements with rejected platform ownership. Their record is
the split plan; the owning implementation issue must accept its seam and data/security proof before
re-expressing the Marketing half. Nothing may be copied while that review is pending.

- `public-marketing-delivery-scaffolding`
- `console-organization-auth-and-database-boundary`
- `console-conversation-continuity`
- `console-marketing-connected-tools`
- `console-public-access-surfaces`
- `web-conversation-continuity`
- `web-component-conversation-continuity`
- `server-marketing-prompting`
- `server-marketing-app-connections`
- `server-conversation-continuity`
- `contracts-mixed-identity-conversation-workspace`
- `database-tenant-identity-and-provisioning`
- `database-conversation-and-transcript-state`
- `database-connected-tools-and-social`
- `database-public-access-and-invitation`
- `shared-mixed-marketing-workspace-logic`

The recurring split is strict:

- keep organization/workspace/role requirements; reject donor authentication, tokens, actors,
  devices, sessions, and writer authority;
- keep Marketing provenance; reject donor thread, transcript, recovery, and transport authority;
- keep bounded Marketing evidence/action receipts; reject donor OAuth, secret, generic connector,
  job, and external-action authority;
- keep Marketing instruction requirements; reject global prompt compilation, rollout, and provider
  delivery;
- keep public access intent; reject fork deployment, pairing, desktop enrollment, and release
  infrastructure.

## Replace with T3

- `web-auth-and-desktop-first-run`
- `web-component-auth-surfaces`
- `web-shared-t3-surface`
- `server-shared-t3-runtime`
- `desktop-auldric-runtime`
- `desktop-shared-t3-shell`
- `contracts-shared-t3-remainder`
- `shared-explicit-platform-overlap`
- `shared-t3-remainder`
- `auldric-auth-package`
- `generic-t3-packages`
- `donor-generic-docs`
- `donor-scripts-remainder`
- `legacy-docs-apps`
- `fork-deployment-ci-and-release-config`
- `fork-hidden-plans-and-duplicate-docs`
- `root-workspace-tooling-and-governance`

This resolves every overlapping auth, provider/session/orchestration, WebSocket/transport, shell,
desktop, Git, terminal, preview, remote/Connect, package, protocol, CI, release, and generic tooling
implementation to current T3.

## Retire

- `console-generic-work-and-operations`
- `console-standalone-platform-remainder`
- `web-generic-work-and-command-features`
- `web-component-generic-work-surfaces`
- `server-duplicate-control-plane-and-work-runtime`
- `contracts-retired-generic-auldric-platform`
- `database-generic-work-and-control-plane`
- `database-package-remainder`
- `benchmark-agent-runtime-remainder`
- `mcp-runtime-and-generic-runbooks`
- `auldric-lint-plugin`
- `donor-hard-fork-and-runtime-guidance`
- `donor-brand-and-namespace-scripts`
- `fork-agent-command-state`

These are the duplicate console/control plane, generic Work/Loops/Runs/tasks/commands/skills,
standalone database/runtime, custom MCP server, global rebrand, and hard-fork guidance. They receive
no downstream implementation issue.

## Upstream dependencies

- `web-connected-tool-and-voice-experiments`
- `web-component-connected-and-upstream-surfaces`
- `server-external-catalog-and-voice`
- `contracts-connected-and-external-capabilities`
- `nango-marketing-integration`

Catalog/search, voice, task/action, connector, OAuth/secret, and generic provider capability remains
parked until T3 exposes a supported seam and a new or existing executable Marketing issue accepts
the permission, consent, receipt, failure, and tenant contract. Legacy implementation is not a
temporary fallback.

## Historical evidence

- `component-lab-auldric-prototypes`
- `component-lab-remainder`
- `web-auldric-design-systems`
- `web-component-design-prototypes`
- `desktop-brand-evidence`
- `database-legacy-sql-history`
- `donor-auldric-system-docs`
- `donor-plans-prds-reports-and-proofs`
- `root-day0-evidence-documents`
- `generated-artifacts-assets-and-temp-proof`

Historical migrations must never run. Historical plans/reports/screenshots must never become active
documentation, current completion status, customer fixtures, or launch claims. Fresh implementation
requires fresh tests, canonical read-back, and current screenshots where applicable.

## Surface decisions

- Entry points: the inventory authorizes no user-visible entry point by itself. #13/#21 own the
  Marketing shell; settings, command palette, and keybinding decisions remain required there.
- Clients: web is the first Marketing composition surface. Desktop may wrap it through native T3.
  Mobile requires an explicit decision by the owning UI issue; no donor mobile/control-plane code
  survives.
- Providers: no donor provider delivery survives. Marketing context must use one supported T3
  per-turn seam or remain parked, with a decision for Codex, Claude, Cursor, Grok, and OpenCode.
- Contracts: accepted Marketing records are additive and typed in current `packages/contracts`;
  donor wire shapes are evidence only.
- Reverse states: every new membership, source, workflow, review, approval, or handoff requires a
  visible revoke/remove/reopen/reject/return path in its owning issue.
- Connection modes: no donor transport survives. Current local, remote/relay, tunnel, and
  multi-environment behavior must remain native T3.
- Docs: this audit is an active internal checkpoint; legacy documentation remains at the donor ref
  as historical provenance.

## Completion

**Decision:** Approve only the 14 keep/rebuild records as bounded Marketing requirement evidence.
Approve the 16 split records only as reviewed split plans; their Marketing half still requires the
named issue's current contract and supported seam. Replace every shared/platform overlap with T3,
retire the duplicate runtime, archive legacy proofs, and keep upstream-dependent work parked. No
legacy code, SQL, state, credentials, build configuration, or Git history is approved for porting.

**Next action:** #4 may land the explicit Marketing route/lazy-domain boundary. #5 and #6 may then
define verified-actor Marketing mappings, followed by #8's organization-owned persistence. Pure
Marketing contracts and definitions proceed only in their named issue after those prerequisites.

**Parked until:** Split records wait for their owning issue to accept the seam, migration/rollback,
tenant/security model, and proof. Upstream records wait for a T3-owned generic seam and executable
Marketing scope. Workflow/UI implementation that depends on identity, authorization, storage,
evidence, or review remains parked until those contracts land.
