# Epic 04: Integration Platform

## Purpose

The integration platform allows projects to be created from external systems and lets
skills read external context through a stable tool surface. It is the **Sources** axis of
the [vision](./00-vision.md): the platform owns the plumbing (auth, caching, sync,
normalization, reviewable mutations, the cross-provider graph) so that connecting a new
back-end is plugin code, not a new product.

Atlassian is the first implementation, not the abstraction. A back-end is made available
by a **connector**; Atlassian is the first connector.

## Core Concepts

### Integration Account

An authenticated account or site connection.

```ts
type IntegrationAccount = {
  id: string;
  provider: string;
  label: string;
  accountUrl?: string;
};
```

### External Project

A project-like object exposed by an integration.

```ts
type ExternalProject = {
  id: string;
  provider: string;
  title: string;
  key?: string;
  url?: string;
  description?: string;
  raw?: unknown;
};
```

### Resource Ref

A stable pointer to an external object.

```ts
type ResourceRef = {
  provider: string;
  kind: string;
  id: string;
  displayId?: string;
  title: string;
  url?: string;
  projectId?: string;
};
```

### Resource Snapshot

A normalized, cached copy of an external resource.

```ts
type ResourceSnapshot = {
  ref: ResourceRef;
  fetchedAt: string;
  summary?: string;
  fields: Record<string, unknown>;
  text?: string;
  raw?: unknown;
};
```

## Provider Interface

Every provider should support discovery, reading, search, action discovery, and
reviewable mutation flows.

```ts
type IntegrationProvider = {
  id: string;
  kind: string;
  listAccounts(): Promise<IntegrationAccount[]>;
  listProjects(account: IntegrationAccountRef): Promise<ExternalProject[]>;
  listResources(input: ListResourcesInput): Promise<ResourcePage>;
  getResource(ref: ResourceRef): Promise<ResourceSnapshot>;
  search(input: IntegrationSearchInput): Promise<ResourceSearchResult[]>;
  getAvailableActions(ref: ResourceRef): Promise<IntegrationAction[]>;
  prepareMutation(input: PrepareMutationInput): Promise<PreparedMutation>;
  commitMutation(input: CommitMutationInput): Promise<MutationResult>;
};
```

## Connectors — Authoring a Source

The `IntegrationProvider` interface above is the runtime contract. Today connectors are
**team-authored TypeScript** living in `packages/integrations-*` (with the abstraction in
`integrations-core` and Atlassian in `integrations-atlassian`).

The North Star is that a connector is a **plugin module authored with `defineConnector`** —
a peer of `defineRecipe` in the same SDK — and ultimately authorable **in the app, by the
user's own agent** (the `create-recipe` / `edit-plugin-module` pattern generalized to
connectors). Adding a Source becomes the same act as adding a recipe: write a typed module,
review it, run it.

### Open provider slug

`provider` is an **open branded slug**, not a closed enum — mirroring `ProviderDriverKind`
on the AI-runtime side, which is already open. Adding a Source must never require editing a
central union. (See `packages/contracts/src/providerInstance.ts` for the existing
open-slug precedent.)

### One connector can span a product family

A connector is not limited to one resource kind. The **Atlassian connector exposes both
Jira issues and Confluence pages** under a single account/site connection — see
[Epic 26 — Knowledge Workbench](./26-knowledge-workbench.md). Resource domains are
declared by the connector; the platform routes by `(provider, kind)`.

### Platform owns the plumbing; the author owns the back-end

A connector author implements only the back-end-specific behavior. The platform supplies
auth, the queryable cache (`Queryable<T>`), background sync, freshness polling, the
reviewable mutation flow, and cross-provider link resolution.

```ts
// Illustrative North-Star shape — peer to defineRecipe.
const atlassian = defineConnector({
  id: "atlassian",                 // open slug; unique per project
  label: "Atlassian",
  domains: ["jira-issue", "confluence-page"], // product family
  auth: oauthSite({ /* platform-managed */ }),
  listProjects,                    // back-end-specific reads...
  listResources,
  getResource,
  search,
  getAvailableActions,
  extractRelations,                // link extraction → cross-provider graph (Epic 13)
  prepareMutation,
  commitMutation,
});
```

MVP ships Atlassian as a team-authored connector; the SDK surface and in-app authoring are
the planned path, not the first slice.

## Mutation Design

All external writes should be two-step:

1. `prepareMutation` returns a reviewable mutation model.
2. `commitMutation` executes only after explicit approval.

This lets skills draft useful work while keeping user consent clear.

## Caching

The platform should cache:

- project lists
- resource lists
- resource snapshots
- search results where useful
- mutation audit records

The cache layer has two complementary storage forms:

1. **Local SQL cache** — the primary store for queryable provider data, in the existing
   `effect/sql` persistence layer
   ([apps/server/src/persistence/Layers/Sqlite.ts](../../apps/server/src/persistence/Layers/Sqlite.ts)).
   Provider sync writes into namespaced tables; recipes, Views, and workflow steps consume
   this through the `Queryable<T>` contract defined in
   [Epic 16 — Context: Reactive Queryable Surface](./16-action-recipes.md#context-reactive-queryable-surface).
   Mutations flow through the existing orchestration-events / projection pipeline, which
   drives reactive invalidation for client consumers.
2. **Managed workspace files** — raw provider payloads and large blob assets live under
   `<managed-project>/sources/<provider>/` and `<managed-project>/cache/`. These are the
   on-disk record (useful for audit, agent inspection, and re-deriving the SQL projection),
   not the primary query substrate.

The t3work-Atlassian backlog cache
([apps/server/src/t3work-atlassian-backlog-cacheReadWrite.ts](../../apps/server/src/t3work-atlassian-backlog-cacheReadWrite.ts))
is the existing template for new providers.

## Future Connectors

The same model should fit:

- Linear teams/issues
- GitHub repositories/issues/pull requests
- Azure DevOps projects/work items
- Notion databases/pages
- Zendesk groups/tickets
- local file collections

These are the connectors the team may ship; the **long tail is user-authored** — any
back-end becomes a Source via a `defineConnector` module, without the platform shipping it
first.
