# Engineering Constitution

## Position

`t3work` should reuse T3 Code's existing engineering conventions wherever they
exist. This constitution is an overlay for the new `t3work` packages and app, not a
replacement for the repository's baseline rules.

If a T3 Code convention and this document conflict, prefer the stricter rule unless it
would make integration with upstream T3 Code materially harder.

## Core Values

1. Correctness over speed.
2. Reuse over copy.
3. Small composable modules over large local implementations.
4. Explicit contracts over implicit prompt behavior.
5. Durable artifacts over disposable chat output.
6. Reviewable side effects over hidden automation.

## Existing Shell Baseline

`t3work` must start from the existing T3 Code shell and UI as its baseline.

This is mandatory. The first implementation should copy or import the existing shell,
layout, navigation patterns, primitives, and interaction behavior from the T3 Code app,
then adapt that baseline for `t3work` workflows.

Preferred order:

1. Import an existing T3 UI primitive or shell component.
2. Extract a reusable primitive from existing T3 UI if the boundary is clean.
3. Copy existing T3 UI into `apps/web/src/t3work` when extraction would slow the MVP.
4. Adapt the copied/imported baseline for `t3work` needs.
5. Create new UI only when no useful T3 baseline exists.

The goal is not visual novelty. The goal is to preserve the behavior, density, and
interaction quality of the existing T3 app while changing the starting point from local
workspace chat to project-oriented recipes and resources.

Any new `t3work` UI surface should be able to answer:

- Which existing T3 shell surface did this start from?
- What did we keep unchanged?
- What did we adapt for the `t3work` use case?
- Why was new UI necessary, if any?

## Package Boundaries

`t3work` code lives in additive packages. New files must either use the `t3work-` /
`t3work.` prefix or sit in a whitelisted package path (see
[`docs/t3work-additive-whitelist.md`](../t3work-additive-whitelist.md) and the additive
extension pattern in [Epic 02](./02-additive-architecture.md#additive-extension-pattern)).

Current `t3work` additive packages on disk:

- `apps/web/src/t3work`
- `packages/project-context` (formerly proposed as `t3work-context`)
- `packages/project-recipes` (formerly proposed as `t3work-recipes`)
- `packages/integrations-core` (formerly proposed as `t3work-integrations-core`)
- `packages/integrations-atlassian` (formerly proposed as `t3work-integrations-atlassian`)
- `packages/t3work-skill-packs`
- `@t3work/sdk` — the additive workflow/tool authoring SDK (Epic 25: `defineWorkflow`,
  `defineTool`, `defineToolGroup`, `defineModel`, `defineScript`); also the public import
  path for the recipe and View/placement `define*` helpers

The unprefixed names (`project-*`, `integrations-*`) are explicitly whitelisted in the
additive guard because they predate the prefix policy. Anything new should prefer the
`t3work-` prefix unless extending one of these existing packages.

Rules:

- If a dedicated adapter package is introduced later, it is the only package allowed to
  deep import unstable T3 internals.
- Integration-specific logic must not leak into generic project, recipe, or artifact
  packages.
- UI components must not call integration clients directly.
- Skills and recipes should depend on tools/contracts, not concrete service clients.
- New cross-cutting concerns follow the additive extension pattern: minimal optional seam
  upstream + all logic in `t3work-`-prefixed files. Do not grow the modified-files
  allowlist if a smaller seam exists.

## File Size

Target maximum: 150 lines per source file.

Allowed exceptions:

- generated files
- schema files where splitting would reduce readability
- static fixture data
- test files with clear scenario grouping
- route files during early prototyping, if split before stabilization

Files above 150 lines should trigger a design check:

- Is there a reusable component to extract?
- Is there a schema/helper that belongs in a package?
- Is this mixing rendering, state, data fetching, and transformation?
- Is the test covering too many behaviors at once?

## Composition

Prefer small, named units:

- pure transformation helpers
- schema modules
- provider adapters
- focused hooks
- focused UI components
- artifact block renderers
- recipe definitions separated from recipe execution

Avoid:

- copy-pasted provider logic
- one-off button handlers that embed workflow prompts
- components that fetch, normalize, render, and mutate in the same file
- local stringly typed resource shapes when shared schemas exist
- large recipe prompts without reusable prompt blocks

## Reuse Rule

Before adding new logic, check for an existing package or helper that should own it.

Reuse order:

1. Existing T3 Code public contracts/packages.
2. Project-shell shared packages.
3. Existing UI primitives.
4. New shared helper.
5. Local implementation only when the behavior is genuinely one-off.

Duplication is acceptable only for temporary exploration and should be called out before
the code is considered stable.

## Testing Standard

Target coverage for `t3work` packages: 90-100%.

This is a product reliability target, not a vanity metric. Coverage should focus on
meaningful behavior:

- schema decoding
- recipe applicability matching
- integration normalization
- managed workspace path logic
- mutation prepare/commit state transitions
- artifact persistence
- adapter behavior around T3 boundaries
- UI state transitions for important user flows

Coverage expectations:

- Pure packages should approach 100%.
- Integration packages should heavily test normalization, pagination, and error mapping
  with fixtures.
- UI should use focused component tests plus Storybook/snapshot coverage.
- Adapter code should have contract tests around the T3 boundary.

Do not write brittle tests that only assert implementation details.

## Storybook And Screenshots

Every reusable `t3work` component should have Storybook coverage before it is
considered stable.

Required stories:

- default state
- loading state
- empty state where applicable
- error state where applicable
- dense/long-content state
- narrow/mobile-ish state for layout-sensitive components

Important screens should have snapshot coverage:

- project browser
- create project flow
- Jira project picker
- project overview
- Jira issue detail
- recipe launcher
- artifact viewer
- mutation preview

Snapshots should catch visual regressions in layout and content density. They should not
be the only test for behavior.

## Rich Artifact Discipline

Skills should not default to long markdown paragraphs when a structured artifact would
serve the user better.

Preferred outputs:

- test matrices
- risk boards
- checklists
- forms
- mutation previews
- comparison tables
- timelines
- linked source summaries

Every artifact should record:

- project ID
- source resource references
- creating thread/run
- creation/update time
- durable local path or ID

## Integration Discipline

External integrations must use generic provider contracts first.

Atlassian-specific code belongs in `packages/t3work-integrations-atlassian`. The rest of the
shell should see normalized accounts, projects, resources, snapshots, actions, and
mutations.

Integration network calls must execute behind the backend boundary, not from browser UI
code. UI components and hooks may call t3work backend methods, but must not
instantiate external provider clients or call third-party APIs directly.

Credential material must not be persisted in browser storage. OAuth tokens, API tokens,
Basic auth headers, refresh tokens, and provider-specific secrets belong in backend
credential/session storage. Browser code may collect credentials for a connect action and
transmit them to the backend over the local authenticated channel, then should use opaque
account/project/resource identifiers for follow-up reads and writes.

Backend integration adapters must own:

- third-party auth headers
- retries and rate-limit behavior
- transport/CORS diagnostics
- request/response logging with secret redaction
- provider-specific error normalization

The frontend must receive actionable normalized errors, for example authentication
failure, missing scope, inaccessible site, rate limited, or network/proxy failure.

External writes must be reviewable:

- skills can prepare mutation proposals
- users review and edit in UI
- commit happens only after explicit approval
- results are recorded locally

## UI Discipline

`t3work` is an app for repeated work, not a marketing page.

UI should be:

- dense but readable
- action-oriented
- clear about source context
- explicit about side effects
- optimized for scanning tickets, recipes, artifacts, and runs

Avoid:

- large hero sections
- decorative cards for core work surfaces
- explanatory copy where concrete actions would be better
- chat as the only visible way to start

## Mandatory Browser Validation

Every UI or workflow change must be validated by the agent in a real browser before it is
considered done.

The agent must:

- start the relevant local app
- open it in the browser
- click through the changed flow manually
- verify the end-to-end path works, not only that the code compiles
- inspect important states such as loading, empty, error, and success where feasible
- capture or inspect screenshots for layout-sensitive changes
- report exactly what was validated

For `t3work` work, browser validation should cover the affected path, for example:

- project browser opens
- create project flow is reachable
- Jira project picker renders
- project overview renders
- issue detail renders
- recipe launcher starts the intended flow
- artifact viewer displays the saved output
- mutation preview can be reviewed before commit

No UI change should be marked complete based only on unit tests, typechecking, or static
inspection.

## Definition Of Done

A `t3work` feature is done when:

- it follows existing T3 Code conventions where applicable
- it starts from copied or imported T3 shell/UI elements unless a documented exception
  exists
- package boundaries are respected
- files are small or have justified exceptions
- shared schemas/contracts are used
- tests cover behavior and edge cases
- reusable components have Storybook stories
- important screens have snapshot coverage
- the agent has opened the app in a browser and clicked through the changed flow
- external mutations are reviewable
- generated outputs are persisted as artifacts where appropriate
- no broad existing T3 Code changes were required without documenting why

## When To Bend The Rules

The MVP can bend rules during exploration, but the exception must be visible.

Acceptable temporary exceptions:

- duplicate UI copied from T3 shell to validate the product direction
- route files over 150 lines during the first prototype
- mock providers before real integration clients exist
- lower coverage for a spike branch

Before stabilization, temporary exceptions should either be removed or written down with
a clear reason and cleanup path.
