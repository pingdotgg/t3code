# Auldric Marketing domain

This directory is the canonical documentation spine for the isolated Auldric Marketing/Strategy
domain in this repository. It is an authority and requirements checkpoint, not proof that the
described Marketing capabilities are implemented.

## Authority contract

T3 owns Dev and shared platform infrastructure. Native Dev uses T3 modes, instructions, tools,
agents, provider/session logic, transport, shell, Git, terminal, preview, authentication, Connect,
collaboration, remote access, CI, packaging, and release behaviour.

Auldric owns only Marketing sources, evidence, Day 0, Marketing Strategy and GTM workflows,
artifacts, plans, decisions, reviews, claims rules, and explicitly approved implementation briefs.
Auldric compilation and evidence run only after explicit Marketing-domain selection. Missing or
unknown domain resolves to native Dev. Marketing failure cannot change or interrupt Dev.

If Marketing needs a generic capability that T3 does not expose, record an upstream dependency or
park the work. Do not add a fork-only provider, session, prompt, authentication, transport,
connection, remote, shell, Git, preview, CI, or release implementation.

## Reading order

1. [Current state](./00-current-state.md)
2. [Product-domain seam](./01-product-domain-seam.md)
3. [Desktop operating model](./02-desktop-operating-model.md)
4. [Marketing data and evidence](./03-marketing-data-and-evidence.md)
5. [Marketing workflows and artifacts](./04-marketing-workflows-and-artifacts.md)
6. [Marketing review and claims](./05-marketing-review-and-claims.md)
7. [Capabilities and boundaries](./08-capabilities-and-boundaries.md)
8. [Marketing agent contract](./09-agent-operating-contract.md)
9. [Legacy donor inventory decision](./10-legacy-donor-inventory.md)
10. [Architecture](../auldric-architecture.md)
11. [Launch readiness](../auldric-launch-readiness.md)

The [legacy runtime archive index](../_archive/auldric-runtime/README.md) is provenance only. It is
not part of this reading order and must not steer implementation.

## Precedence and issue ownership

GitHub issue #1 owns the platform authority decision. #2 owns the current T3 baseline and drift
policy. #3 owns outward identity and distribution configuration. #14 owns the donor inventory and
must approve each bounded Marketing rebuild. #4 through #11 and #18 through #20 own domain, data,
evidence, workflow, provenance, continuity, and handoff implementation. #13 and its children own the
in-product Marketing UI. #27 owns public marketing/access surfaces.

When a deeper plan conflicts with this spine or native T3 behaviour, this spine and T3 authority
win. A completed legacy plan never proves a capability exists in this repository.

## Document registration

Active, superseded, and historical documents are registered in
[`manifest.json`](./manifest.json). After changing this spine or another registered Auldric product
checkpoint, run:

```bash
pnpm run complete:feature-docs
```

The command verifies manifest coverage, required authority statements, and contradictory active
guidance. This repository has no Auldric internal-document database or sync service; the command
does not claim to update one. Reviewed repository Markdown is the current documentation authority
until a separately approved canonical store exists.

## Completion language

Research and planning checkpoints close with `Decision`, `Next action`, and `Parked until` so
unapproved or upstream-dependent work cannot be mistaken for implementation permission.
