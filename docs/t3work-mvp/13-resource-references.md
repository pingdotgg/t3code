# Epic 13: Resource References

## Purpose

Jira issues and other external entities should be referenceable in the composer just like
files.

T3 Code already uses:

- `@` for file and folder mentions
- `$` for skills
- `/` for commands

`t3work` should reuse this model. External resources should use `@`, not introduce a
new primary symbol.

## Principle

Use one mental model:

```text
@ means attach or reference context
$ means invoke a skill
/ means run a command
```

That means:

- `@src/App.tsx` references a file
- `@jira:ABC-123` references a Jira issue
- `@confluence:SPACE/page-title` can later reference a Confluence page
- `$qa.create-test-plan` invokes a skill
- `/model` opens a command

## Existing T3 Baseline

Current T3 composer behavior:

- `@query` triggers workspace file/folder search.
- `$query` triggers skill search.
- `/query` triggers command search.
- Composer selected mentions become inline chips/segments.

`t3work` should extend this instead of creating a separate resource picker model.

Relevant existing files:

- `apps/web/src/composer-logic.ts`
- `apps/web/src/composer-editor-mentions.ts`
- `apps/web/src/components/chat/ComposerCommandMenu.tsx`
- `apps/web/src/components/chat/ChatComposer.tsx`

## Resource Reference Syntax

### Canonical

Use typed `@provider:id` references.

Examples:

```text
@jira:ABC-123
@jira:PROJ-42
@confluence:ENG/runbook-release
@github:owner/repo#123
@linear:TEAM-123
```

### Display Labels

The composer can render richer labels while preserving canonical text internally.

Example:

```text
@jira:ABC-123
```

renders as a chip:

```text
ABC-123 · Login fails on Safari
```

### Project-Scoped Shorthand

When the active project has a default Jira source, allow shorthand issue keys:

```text
@ABC-123
```

This should resolve to:

```text
@jira:ABC-123
```

Only enable shorthand when it is unambiguous.

## Picker Behavior

Typing `@` opens one combined reference menu.

Groups:

- Files
- Jira issues
- Project artifacts
- Project memory
- Later: Confluence, GitHub, Linear, local documents

Ranking should prefer:

1. resources from the active project
2. recently opened resources
3. exact key matches
4. title matches
5. files, if the query looks path-like

Examples:

```text
@ABC
```

should show:

- Jira issue `ABC-123`
- Jira issue `ABC-456`
- matching local files only if relevant

```text
@src/
```

should prioritize files.

```text
@jira:
```

should show Jira issues only.

## Composer Item Model

Extend the existing command menu item concept with a resource item.

```ts
type ComposerReferenceItem =
  | {
      id: string;
      type: "path";
      path: string;
      pathKind: "file" | "directory";
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "resource";
      ref: ResourceRef;
      label: string;
      description: string;
      icon: ResourceIcon;
      sourceLabel: string;
    };
```

Resource rows should use the existing `ComposerCommandMenu` density and behavior.

## Resource Ref Model

Use the shared `t3work` resource model.

```ts
type ResourceRef = {
  provider: string; // open connector slug — e.g. "atlassian", "github", "linear", "local"
  kind: string;
  id: string;
  displayId?: string;
  title: string;
  url?: string;
  projectId?: string;
};
```

`provider` is an open slug, not a closed union — a user-authored connector
([Epic 04](./04-integration-platform.md)) must be referenceable without editing this type.

For Jira:

```ts
const ref = {
  provider: "atlassian",
  kind: "jira-issue",
  id: "cloud:<cloudId>:issue:<issueId>",
  displayId: "ABC-123",
  title: "Login fails on Safari",
  url: "https://example.atlassian.net/browse/ABC-123",
  projectId: "abc",
};
```

## Cross-Provider Links (Embedded References)

Everything above covers references the **user types** into the composer. The platform also
extracts references that are **already embedded inside fetched resource data** — and
promotes them to first-class, openable resources.

This is what makes "the Confluence pages linked from this Jira ticket" real: a Confluence
URL in a ticket description, a Jira remote link, or an Atlassian smart-link is not left as
opaque text — it is normalized into a typed relation that resolves across connectors.

### Relation model

```ts
type ResourceRelation = {
  from: ResourceRef; // e.g. the Jira issue
  to: ResourceRef; // e.g. @confluence:ENG/runbook-release
  kind: string; // "links" | "mentions" | "remote-link" | "child-of" | ...
  source: "body" | "remote-link" | "smart-link" | "field";
};
```

- **Extraction** — a connector's `extractRelations`
  ([Epic 04](./04-integration-platform.md)) parses a fetched snapshot (issue body, remote
  links, page body) and emits relations. Extraction runs at sync/fetch time, not at render
  time.
- **Cross-Source resolution** — `to` may target a different connector. A relation to
  `@confluence:SPACE/page` resolves through Atlassian; one to `@github:owner/repo#1`
  through a GitHub connector. The graph spans Sources.
- **Rendering** — relations render as resource chips (open inline) and populate the
  "linked resources" sections on Resource Detail and Page Detail
  ([Epic 03](./03-project-browser.md), [Epic 26](./26-knowledge-workbench.md)).
- **Maintenance signal** — an unresolved `to` is a stale-link finding for knowledge
  maintenance ([Epic 26](./26-knowledge-workbench.md)).

The cross-provider graph is the connective tissue of the [vision](./00-vision.md); the
[Knowledge Workbench](./26-knowledge-workbench.md) is its primary consumer.

## Thread Attachment Behavior

When a resource reference is sent in a message:

1. Resolve the reference.
2. Fetch or read the latest cached snapshot.
3. Attach a structured resource snapshot to the thread turn.
4. Preserve the inline reference in the visible message.
5. Save the snapshot under the managed workspace cache.

The agent should receive both:

- user-visible text containing the reference
- structured resource context with normalized fields and source URL

For context-bound chat, this file-backed context should be the default way to give the
agent broad project, work-item, backlog, and GitHub activity data. Dedicated read tools
should focus on freshness, narrow live queries, view state, and small option lists rather
than duplicating attached context files.

## Visual Treatment

Use the same inline chip behavior as file mentions.

Resource chips should show:

- product/source icon, such as Jira
- display ID, such as `ABC-123`
- short title when space allows
- tooltip with source, status, and URL

For dense composer rendering:

```text
ABC-123
```

For expanded/detail rendering:

```text
ABC-123 · Login fails on Safari
```

## Resource Search Tooling

Add a generic resource search path under integrations.

```ts
type ResourceSearchInput = {
  projectId: string;
  query: string;
  providers?: string[];
  kinds?: string[];
  limit: number;
};
```

Initial Jira implementation:

- exact issue key lookup
- JQL text search fallback
- recently cached issues
- current project issue list

## Ambiguity Rules

If `@ABC-123` could refer to more than one source, show the picker instead of silently
resolving.

If a resource is inaccessible:

- keep the textual reference
- show an unresolved chip state
- offer reconnect/refresh when possible

If a resource was deleted:

- show cached snapshot if available
- mark it as stale

## MVP Scope

Implement first:

- `@jira:KEY-123` canonical references
- active-project shorthand `@KEY-123`
- Jira issue search in composer menu
- Jira issue chip rendering
- structured Jira issue attachment on send
- stale/unresolved visual state

Next (with the [Knowledge Workbench](./26-knowledge-workbench.md), Epic 26):

- Confluence references (`@confluence:SPACE/page`)
- embedded cross-provider link extraction (`ResourceRelation`) and inline resolution

Defer:

- GitHub PR/issue references
- cross-project references
- bulk references
- natural-language fuzzy resource linking

## Browser Validation

The agent must validate resource references in a browser by clicking through:

1. Open a Jira-backed `t3work` project.
2. Focus composer.
3. Type `@`.
4. Verify files and Jira issues appear in the menu.
5. Type a Jira issue key prefix.
6. Select a Jira issue.
7. Verify the inline chip renders.
8. Send the message.
9. Verify the thread includes structured issue context.
10. Open the same thread again and verify the chip/artifact still resolves from cache.
