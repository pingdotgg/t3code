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
- The public app currently present at `apps/marketing`, which is T3 material and is not proof of an
  approved Auldric public surface.
- This reviewed Marketing-domain authority and requirements spine.

## Capability status

| Capability                                          | Owner    | Current status                       |
| --------------------------------------------------- | -------- | ------------------------------------ |
| Explicit `dev \| marketing` product-domain seam     | #4       | Boundary implemented; #21 UI pending |
| Marketing identities and authorization              | #5, #6   | Not implemented                      |
| Canonical organization-owned Marketing persistence  | #8       | Not implemented                      |
| Bounded Marketing evidence context                  | #9       | Not implemented                      |
| Marketing continuity and immutable provenance       | #7, #11  | Not implemented                      |
| Day 0, Marketing Strategy, GTM, and typed artifacts | #18, #19 | Not implemented                      |
| Approved Marketing-to-Dev brief handoff             | #20      | Not implemented                      |
| In-product Marketing UI and public Auldric surface  | #13, #27 | Not implemented or approved          |

Do not turn a target contract, donor document, mock, generated view, or completed legacy PR into a
current-state claim. Capability becomes current only after its owning issue supplies implementation,
targeted tests, canonical read-back where applicable, and required integrated proof.
