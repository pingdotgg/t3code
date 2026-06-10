# t3work Vision — An Extensible Work Platform

## In One Paragraph

`t3work` is a project-oriented agent workspace that turns the systems you already work
in — Jira today; Confluence, Linear, GitHub, and your own tools tomorrow — into guided,
AI-accelerated work surfaces. It extends along two axes: **Sources** (connect any back-end
as a first-class data provider — the platform handles auth, caching, sync, normalization,
and reviewable mutations for you) and **Surfaces** (compose role-specific pages, panels,
and recipes for how *you* work — QA, product, support, delivery). Atlassian/Jira and the
QA profile are simply the first Source and the first Surface; everything else rides the
same in-app, agent-authorable plugin model.

## The Shift

The early MVP reads as a "guided Jira/QA assistant." That is the first useful slice, not
the product. The product is **a platform for turning structured work systems into
agent-accelerated workspaces** — and for letting users extend that platform themselves
without forking it.

Concretely:

- Jira is **the first Source**, not the definition of the product.
- QA is **the first profile**, not the only audience.
- The Atlassian package is **the first connector**, not the abstraction.

Everything specific lives behind a small set of shared abstractions so that the second,
third, and Nth case is configuration and plugin code — not a new product.

## Two Axes of Extensibility

### Sources — vertical / data extensibility

A **Source** is where work comes from: a Jira project, a Confluence space, a Linear team,
a GitHub repo, a folder of local documents, or a back-end nobody has thought of yet.

A Source is made available by a **connector** — a plugin module authored with
`defineConnector` (see [Epic 04](./04-integration-platform.md)). The integration platform
owns the hard, repetitive parts so a connector author does not have to:

- authentication and account/site discovery
- caching and the queryable local store (`Queryable<T>`, SQL-backed)
- background sync and freshness polling
- normalization into shared resource snapshots
- the two-step reviewable mutation flow (`prepare` → `commit`)
- the cross-provider resource graph (links between resources, across Sources)

A connector author implements only the back-end-specific part: how to list, read, search,
and mutate that system, and how to normalize its data. One connector can span a **product
family** — the Atlassian connector exposes both Jira issues *and* Confluence pages under a
single connection.

Connectors are authored the same way recipes are: as typed TypeScript plugin modules, and
ultimately **in the app itself, with the user's own agent** (the `create-recipe` /
`edit-plugin-module` pattern, generalized to connectors). Atlassian ships team-authored;
the North Star is that any user can add a Source the same way.

### Surfaces — horizontal / experience extensibility

A **Surface** is how you work a Source: the pages, panels, recipes, and automations a
particular role sees. A requirements engineer, a product manager, a QA tester, and a
release coordinator should each be able to shape `t3work` around how *they* work.

The machinery for this already exists across the spec — this axis names it:

- **Profiles** ([Epic 12](./12-profiles-and-skill-packs.md)) — role presets that drive
  tone, recipe ranking, artifact preferences, and sidecar composition. QA, Product
  Partner, Support Triage, Delivery Coordinator, Engineering Copilot ship as starters;
  users clone and author their own.
- **Skill packs** ([Epic 12](./12-profiles-and-skill-packs.md)) — bundles of recipes,
  prompt blocks, and artifact templates for a kind of work.
- **Miniapps & placements** ([Epic 19](./19-workspace-miniapps.md)) — custom UI mounted at
  typed placements (sidecar sections, dashboard widgets, nav sections, conversation cards,
  inline actions) via the `define*` family.
- **Recipes & Views** ([Epic 16](./16-action-recipes.md)) — the launchable, context-aware
  actions and the interactive UI they render.

Surfaces are authored the same way Sources are: typed plugin modules, agent-authorable
in-app.

## One Plugin Model Underneath

Both axes ride a single plugin SDK and a single durable execution engine. There is not a
"connector system" and a separate "recipe system" — there is one model:

- A small `define*` family of typed helpers (`defineConnector`, `defineRecipe`,
  `defineProfile`, `defineSidecarSection`, `defineTool`, …) — see
  [Epic 16](./16-action-recipes.md) and [Epic 19](./19-workspace-miniapps.md).
- A TS-native, replay-based durable **workflow engine**
  ([Epic 25](./25-workflow-engine.md)) backing every automation — agent turns, multi-step
  procedures, scheduled maintenance, long-running escalations.
- A shared **tool broker** and **context** primitive consumed identically by recipes,
  Views, connectors, and workflow steps.
- Authoring **in the app, by the agent** — the user describes what they want; the agent
  writes the plugin module, shows a reviewable diff, and the user approves before any
  code runs.

This is the unifying claim: **adding a new back-end, a new role, or a new automation is
the same act** — write a small typed module against shared primitives, review it, run it.

## What the Platform Owns vs. What You Author

| The platform owns (plumbing)                          | You author (intent)                          |
| ----------------------------------------------------- | -------------------------------------------- |
| Auth, account/site discovery                          | Which Sources to connect                     |
| Caching, queryable store, sync, freshness             | How a connector reads/searches/mutates       |
| Normalization into shared snapshots                   | How a back-end's data maps to snapshots      |
| Reviewable mutation flow (prepare → commit)           | Which Surfaces/pages a role sees             |
| Cross-provider resource graph                         | Which recipes and automations exist          |
| Durable workflow execution, permission UI             | What "good output" looks like for your work  |

The dividing line is deliberate: the boring, security-sensitive, easy-to-get-wrong parts
are the platform's job; the parts that encode *your* work are yours to author.

## The Cross-Provider Resource Graph

Sources are not islands. A Jira ticket links a Confluence page; a Confluence page
references a GitHub PR; a Linear issue points back at a ticket. `t3work` treats these
links as **first-class, resolvable, openable resources** — not opaque URLs buried in text.

The platform extracts links embedded in fetched snapshots, normalizes them into typed
relations, and resolves them across connectors (see
[Epic 13 — Cross-Provider Links](./13-resource-references.md) and
[Epic 26 — Knowledge Workbench](./26-knowledge-workbench.md)). This connective tissue is
what makes "the Confluence pages linked from this ticket" a real, navigable thing — and
what makes knowledge-maintenance automations (find stale links, detect drift between a
spec and its tickets) possible at all.

## Non-Goals

- Do not replicate the source products. `t3work` is an **acceleration layer**, not a Jira
  replacement or a Confluence replacement.
- Do not fork T3 Code. The platform is additive (see
  [Epic 02](./02-additive-architecture.md)).
- Do not let connectors or recipes mutate external systems without a reviewable UI.
- Do not gate the platform on one role, one Source, or one product family.

## Where This Goes (North Star)

- **Arbitrary Sources** — any back-end becomes a Source via a connector, authored in-app
  by the user's agent.
- **Arbitrary Surfaces** — any role composes its own pages, recipes, and automations.
- **Knowledge that maintains itself** — agents don't just read documentation; they keep it
  consistent, current, and correctly linked, through reviewable durable workflows.
- **A graph, not silos** — work resources reference each other across Sources, and the
  agent can traverse that graph on the user's behalf.

## Map to the Epics

- Additive foundation — [Epic 02](./02-additive-architecture.md)
- Sources axis (connectors, integration platform) —
  [Epic 04](./04-integration-platform.md), first connector
  [Epic 05](./05-atlassian-mvp.md)
- Surfaces axis (profiles, packs, miniapps, recipes) —
  [Epic 12](./12-profiles-and-skill-packs.md),
  [Epic 19](./19-workspace-miniapps.md), [Epic 16](./16-action-recipes.md)
- Cross-provider graph — [Epic 13](./13-resource-references.md)
- Knowledge Workbench (Confluence as first knowledge Source) —
  [Epic 26](./26-knowledge-workbench.md)
- Durable execution engine — [Epic 25](./25-workflow-engine.md)
</content>
</invoke>
