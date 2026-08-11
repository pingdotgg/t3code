# Auldric current state

## Repository truth

At the start of issue #17, this repository is a native T3 fork. Inspection found no Auldric
Marketing runtime, product-domain switch, organization-workspace data layer, evidence compiler,
Day 0 kernel, Marketing Strategy/GTM catalog, Marketing Library, review system, or approved Dev
handoff. The referenced Auldric system documents also did not exist here before this checkpoint.

The current T3 pin is deliberately not duplicated in this file; issue #2 owns and updates that
machine-verifiable baseline.

## What exists

- Native T3 web, desktop, mobile, server, provider, conversation, transport, Git, terminal,
  preview, Connect, collaboration, remote, CI, and release behaviour.
- The explicit route-owned `dev | marketing` product-domain boundary selected by issue #4. Its
  lazy payload currently contains only the boundary proof; issue #21 owns the usable Marketing
  shell. Hosted static remains fail-closed until issue #6 supplies a verified environment actor.
- The T3 public app at `apps/marketing`, retained unchanged, and the separate fail-closed Auldric
  information site at `apps/auldric-public`. The Auldric site defaults to noindex and exposes no
  access, collection, price, or download without verified publication inputs.
- The issue #5 Marketing identity-routing and physical organization-database foundation in
  `packages/auldric-marketing-domain`. It is fail-closed behind an injected request-authority seam;
  issue #6 still owns the T3 server composition and role mapping.
- The issue #8 canonical Marketing persistence foundation in the same package: organization-local
  heads and immutable revisions for sources, workflow instances, plans, artifacts, saved outputs,
  reviews, decisions, and next actions, with expected-version conflicts, idempotency, typed lineage,
  registered-view isolation, sealed revision children, workspace-wide canonical claims, canonical
  read-back, and strict organization schema v3 migration.
- The issue #9 bounded evidence-context core in the same package: exact-source allowlists,
  independent source states, deterministic whole-item budgets, evidence receipts, registered
  source/fact schemas, and explicit accepted-fact transitions over the canonical store. No T3
  production request or prompt path imports it; #6 composition remains pending.
- This reviewed Marketing-domain authority and requirements spine.

## Capability status

| Capability                                          | Owner    | Current status                                                 |
| --------------------------------------------------- | -------- | -------------------------------------------------------------- |
| Explicit `dev \| marketing` product-domain seam     | #4       | Boundary implemented; #21 UI pending                           |
| Marketing identities and authorization              | #5, #6   | #5 storage boundary implemented; #6 server composition pending |
| Canonical organization-owned Marketing persistence  | #8       | Store/read-back foundation implemented; composition pending    |
| Bounded Marketing evidence context                  | #9       | Package core implemented; #6 production composition pending    |
| Marketing continuity and immutable provenance       | #7, #11  | Not implemented                                                |
| Day 0, Marketing Strategy, GTM, and typed artifacts | #18, #19 | Not implemented                                                |
| Approved Marketing-to-Dev brief handoff             | #20      | Not implemented                                                |
| In-product Marketing UI                             | #13      | Not implemented                                                |
| Public Auldric information/access-state surface     | #27      | Static site; capabilities gated                                |

Do not turn a target contract, donor document, mock, generated view, or completed legacy PR into a
current-state claim. Capability becomes current only after its owning issue supplies implementation,
targeted tests, canonical read-back where applicable, and required integrated proof.
