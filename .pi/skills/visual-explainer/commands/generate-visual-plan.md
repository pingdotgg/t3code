---
name: generate-visual-plan
description: Generate a visual implementation plan
---

Load the visual-explainer skill and generate a self-contained HTML implementation plan for: $@

## Research first

Read relevant repo files before planning. Identify entry points, existing patterns, affected modules, public APIs, tests, config/schema/data model, similar features, and constraints from README/CHANGELOG/docs.

## Required page sections

1. Goal and scope: what will change and what is intentionally out.
2. Current state: short diagram/table of existing architecture.
3. Proposed design: architecture/data/control flow, preferably Mermaid or hybrid cards.
4. Implementation sequence: ordered phases with dependencies.
5. File map: files to create/edit/delete and why.
6. Interface/contracts: types, APIs, schemas, CLI flags, config, events.
7. Risk and decision matrix: correctness, tests, migration, release, UX, security/privacy, performance.
8. Test plan: unit/integration/e2e/edge cases mapped to files.
9. Acceptance checklist: observable done criteria.

Use hierarchy: overview and architecture dominate; detailed file/test/reference sections stay compact or collapsible. Follow the skill’s Mermaid, table, overflow, and delivery rules.

Write to `~/.agent/diagrams/` and open in browser.
