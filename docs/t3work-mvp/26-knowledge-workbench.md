# Epic 26: Knowledge Workbench

## Purpose

Documentation and knowledge work are unaddressed today. `t3work` has structured-issue
support (Jira) but nothing for the wiki/documentation half of how teams actually work —
Confluence, in Atlassian terms — where requirements, runbooks, decisions, and specs live.

The **Knowledge Workbench** is a provider-agnostic *documents* surface, a sibling to the
Backlog and My Work surfaces. **Confluence is its first Source.** It is the knowledge-side
counterpart to the issue-side Backlog browser.

This epic also realizes the [vision](./00-vision.md) along the **Sources** axis: knowledge
is a second resource domain, and connecting it should not require a second product — just
a second domain exposed by a connector.

## Principle — Accelerate, Don't Replicate

`t3work` does not try to be Confluence. We cannot and should not replicate a full wiki
editor. The job is to **accelerate knowledge work with agents**: read into documents,
connect them to the rest of the work graph, author from existing context, and keep the
knowledge base healthy.

This mirrors the existing non-goal "do not build a full Jira replacement." The Knowledge
Workbench is an acceleration layer over a documentation Source, not a wiki.

## Relationship to Atlassian (Shared Connection)

Confluence is **not a separate integration to connect**. It is a second resource domain of
the same Atlassian connection that already serves Jira:

- One Atlassian OAuth/site connection exposes **both** Jira issues and Confluence pages.
- A `t3work` project created from a Jira site can light up its Knowledge Workbench from the
  same connection, with no extra auth step.
- This is the worked example for the [Epic 04](./04-integration-platform.md) rule that a
  single connector can span a **product family** rather than one resource kind.

## Surface Shape

The Knowledge Workbench mirrors the [Project Browser](./03-project-browser.md) pattern so
it feels native, not bolted on. Proposed surface key: `project.knowledge`, a peer to
`project.backlog` and `project.myWork`.

### Knowledge Browser

- spaces / page tree for connected knowledge Sources
- search across pages (title + content)
- recently viewed and recently changed pages
- pages related to the active project / current work

### Page Detail

For a Confluence page (and any future documents Source):

- rendered page content (read-only) with source link
- metadata: space, author, last updated, labels
- **linked resources** — tickets, PRs, and other pages this page references, and items
  that reference *it* (powered by the cross-provider graph, below)
- context-relevant recipes (ask, summarize, draft, check)
- cached/generated artifacts
- reviewable mutation drafts (for authoring/maintenance actions)

## Seed Use Cases

These anchor the epic. They are a designed-for set, not an exhaustive list — the platform
should let users add more via recipes and miniapps.

### 1. Ask across docs

Natural-language Q&A answered from knowledge content, with **citations back to the source
pages**. "What's our release rollback procedure?" → answer + linked pages. Scope can be a
page, a space, or the project's related knowledge.

### 2. Ticket ↔ docs context

Bidirectional, graph-powered:

- On a Jira ticket: auto-surface the Confluence pages it links or relates to.
- On a page: surface the tickets/PRs that reference it.

This is the use case the user called out as "first-class": a Confluence link inside a Jira
ticket is a real, openable resource, not a bare URL. Depends on the cross-provider graph.

### 3. Author docs

Create and draft documentation with agent assistance, always through reviewable mutation:

- draft a new page from existing context (a ticket, a PR, a thread, a set of pages)
- expand an outline, restructure, or fill gaps in a draft
- propose the change as a reviewable diff before anything is written back to Confluence

Authoring is a **mutation** and follows the prepare → commit flow
([Epic 04](./04-integration-platform.md)): nothing is posted without explicit approval.

### 4. Maintain knowledge

The distinctive pillar — agents that keep a knowledge base healthy, not just readable.
These run as durable workflows ([Epic 25](./25-workflow-engine.md)): scheduled or
triggered, they **scan → detect → propose reviewable fixes**.

- **Sync / freshness** — flag pages that are stale relative to the work they describe
  (e.g., the ticket they document closed weeks ago; the linked spec changed).
- **Stale-link repair** — detect links that no longer resolve (moved/renamed/deleted
  targets) across the resource graph and propose fixes.
- **Inconsistency & ambiguity detection** — surface contradictions between a page and its
  source tickets, duplicate/overlapping pages, or under-specified sections.
- **Keeping things up to date** — propose updates when an upstream Source changes (a
  ticket's acceptance criteria moved; a runbook step references a removed command).

Every maintenance action terminates in a **reviewable mutation**, never a silent write.

## Cross-Provider Resource Graph (Central)

The graph is what elevates this above a document viewer, so it is in-scope from the start
(not deferred). See [Epic 13 — Cross-Provider Links](./13-resource-references.md) for the
model; the Knowledge Workbench is its primary consumer.

- **Link extraction** — when a snapshot is fetched (a Jira issue's description, remote
  links, and smart-links; a Confluence page's body), the connector normalizes embedded
  references into typed relations.
- **Cross-Source resolution** — a relation pointing at `@confluence:SPACE/page` resolves
  through the Atlassian connector; one pointing at `@github:owner/repo#1` resolves through
  a GitHub connector. The graph spans connectors.
- **First-class rendering** — relations render as resource chips (open inline), populate
  the Page Detail / Resource Detail "linked resources" sections, and feed maintenance
  scans (a broken edge is a stale-link finding).

## First Confluence Slice (MVP within this epic)

Ship read + connect + ask first; author + maintain build on top.

In first:

- discover Confluence spaces over the existing Atlassian connection
- browse the space/page tree and search pages
- fetch and normalize page content into a resource snapshot
- extract links between Confluence pages and Jira issues (both directions)
- render linked resources on both Page Detail and Jira Resource Detail
- Ask across docs (use case 1) and Summarize/explain a page

Deferred within this epic:

- page authoring/editing write-back (use case 3) — model the reviewable mutation first
- full-space maintenance automations (use case 4) — land after the workflow engine
  primitives and the graph are stable
- non-Atlassian knowledge Sources (local docs, Notion) — same surface, later connectors

## Provider / Connector Notes

- Confluence reads, searches, and (later) mutations are implemented as resource-domain
  methods on the **Atlassian connector**, sharing its account/auth/cache layers.
- Page content normalization should preserve raw payloads (Atlassian storage/ADF format)
  for re-derivation and agent inspection, alongside a normalized text/summary projection —
  the same dual-store pattern Jira snapshots use ([Epic 04](./04-integration-platform.md)).

## Non-Goals

- Not a Confluence editor or wiki replacement.
- No silent writes — authoring and maintenance always go through reviewable mutations.
- No autonomous, unattended edits to the knowledge base.
- Do not require a separate Confluence connection when an Atlassian one exists.

## Map to Other Epics

- Sources axis / connectors — [Epic 04](./04-integration-platform.md)
- First connector (shared Atlassian connection) — [Epic 05](./05-atlassian-mvp.md)
- Cross-provider links / resource graph — [Epic 13](./13-resource-references.md)
- Durable workflows behind maintenance automations — [Epic 25](./25-workflow-engine.md)
- Surfaces / role profiles that consume knowledge — [Epic 12](./12-profiles-and-skill-packs.md)
- Vision and the two-axis model — [Epic 00](./00-vision.md)
</content>
