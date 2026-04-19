# AGENTS.md

## Mission

Workbench is a folder-first AI workbench for real tasks and real files.

It is built for knowledge workers, technical-adjacent builders, and developers who want a calmer interface for agent-driven work. The product should feel like **“AI that can actually work in my folder”**, not just a chat window or a developer IDE.

When making implementation decisions, prefer:

- clear progress over verbose instrumentation
- visible outputs over hidden internal state
- calm UX over exposed complexity
- provider-neutral product behavior over provider-specific UI branches
- correctness and reliability over short-term convenience

---

## Locked Product Vocabulary

These naming rules should stay stable:

- **Workbench** = the product
- **Console / Consoles** = the user-facing task/files surface
- **Task** = the unit of work / conversation / thread
- **Workspace** = the actual on-disk working directory or worktree concept

Do **not** mechanically rename every `workspace*` symbol in the codebase. Many are technically correct and should remain.

---

## Core Product Principles

1. **Folder-first beats chat-first.**
   - The folder is the center of gravity.
   - Files are inputs, outputs, checkpoints, and proof of work.

2. **Outputs beat instrumentation.**
   - Prefer file previews, recent artifacts, plans, and visible outcomes over raw internal detail.

3. **The Console is a work surface, not a utility drawer.**
   - Strengthen file previews, recent outputs, task context, and viewer actions.
   - Avoid turning it into generic IDE chrome.

4. **Keep the interface calm.**
   - Do not make developer-centric controls the visual center of the app unless clearly justified.

5. **Provider differences belong in adapters.**
   - The shared product should feel coherent even when backends differ.

6. **Silent failure is unacceptable.**
   - If something cannot be supported, surface it explicitly.
   - Do not leave important runtime states visible only in logs.

---

## Core Priorities

1. Performance first.
2. Reliability first.
3. Predictable behavior under load, reconnects, partial streams, and restarts.
4. Maintainability as a first-class concern.

If a tradeoff is required, choose correctness and robustness over short-term convenience.

---

## Maintainability

Long-term maintainability is a core priority.

- Prefer shared logic over duplication.
- If you add functionality, first check whether the logic should live in a shared module.
- Duplicate logic across multiple files is a code smell.
- Do not patch over architectural problems with local hacks if a cleaner shared abstraction is warranted.
- Do not be afraid to improve existing code when doing so makes the system clearer and more reliable.

Prefer small, focused changes:

- separate product copy/polish from mechanical renames
- separate package/import identity changes from persistence/migration changes
- avoid giant mixed diffs
- keep conceptual changes easy to review

---

## Architecture Boundaries

### `apps/web`

React/Vite UI.

Owns:

- Console and Viewer UX
- task/thread interaction flows
- client-side state
- transport/client integration
- settings surfaces
- browser-facing presentation of provider/runtime state

### `apps/server`

Execution boundary.

Owns:

- provider orchestration
- filesystem, git, and terminal access
- persistence and projections
- WebSocket / RPC handling
- canonical runtime normalization
- integrations/connectors that operate on real files
- remote/environment-aware execution behavior

### `apps/desktop`

Electron shell.

Owns:

- desktop-specific platform behavior
- local app shell concerns
- desktop integration points

### `packages/contracts`

Schemas and contracts only.

- Keep this package schema-only.
- No runtime logic.
- Shared types/contracts should be defined here when they cross boundaries.

### `packages/shared`

Shared runtime utilities.

- Use explicit shared modules when logic is cross-cutting and real reuse exists.
- Avoid barrel-driven ambiguity.

---

## Console and Viewer Guidance

The Console is central to the product.

Prioritize additions that improve:

- file previews
- recent outputs
- task and plan visibility
- artifact actions
- output legibility
- export/share destinations
- “what changed?” clarity

Avoid turning the Console into:

- a generic devtools tray
- an overloaded settings surface
- a raw terminal-first workflow
- a code-only inspector

The Viewer should continue to be a strong bridge between agent work and human review.

Good Viewer additions usually:

- make files easier to inspect
- make outputs easier to act on
- connect artifacts back into the task flow
- support export/publish/share actions naturally

---

## Provider Integration Guidance

Workbench supports multiple providers behind a shared product model.

Rules:

- Normalize provider-native behavior into Workbench’s canonical runtime/event model.
- Do not leak provider-specific quirks into the main UI if the adapter layer can absorb them.
- Unsupported capabilities must be surfaced explicitly.
- Do not silently ignore important runtime states like:
  - tool calls
  - approvals
  - user-input requests
  - failures
  - blocked turns
- Feature parity gaps should be documented clearly in code, tests, or planning docs.

Before changing provider behavior, consult the relevant provider references and confirm:

- auth expectations
- tool/event semantics
- session lifecycle assumptions
- interruption behavior
- approval / follow-up input behavior

---

## Integrations and Export Guidance

Workbench is naturally output-oriented. Export/share/integration features should be designed as product-level destinations, not one-off hacks.

Prefer **server/environment-owned execution** for:

- filesystem-backed exports
- connector integrations
- remote-compatible operations
- actions that require full file access instead of preview text

Browser-only implementation is acceptable only for trivial client-side actions.

When adding exports or connectors:

- place actions naturally in Console / Viewer surfaces
- preserve remote-environment compatibility where practical
- use typed contracts
- surface auth and error states clearly
- avoid assuming the browser owns the authoritative file contents

---

## Reference Repos and Docs

Use references to understand behavior, constraints, and integration patterns. Do not cargo-cult naming or UX if it conflicts with Workbench’s product principles.

### Product / architecture ancestry

- T3 Code  
  https://github.com/pingdotgg/t3code

Use for:

- architectural ancestry
- migration context
- inherited runtime patterns
- compatibility questions

### Provider references

- OpenCode  
  https://github.com/anomalyco/opencode

Use for:

- provider/runtime ideas
- CLI/runtime behavior references
- integration design comparisons

- Claude Cowork docs  
  https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork

Use for:

- Claude workflow expectations
- auth/setup behavior
- product semantics and interaction patterns

- pi coding agent  
  https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent

Use for:

- pi CLI/runtime behavior
- auth/session/tool semantics
- event/output expectations

- Codex  
  https://github.com/openai/codex

Use for:

- Codex runtime/app-server behavior
- session/event expectations
- tool calling and lifecycle references

### Reference applications / inspiration

If a feature touches operational UX, session monitoring, or provider ergonomics, consult strong adjacent products and open-source reference apps where helpful. Use them for implementation ideas, not product identity.

---

## Repo-Specific Commands and Completion Requirements

Before considering work complete, all of the following must pass:

- `bun fmt`
- `bun lint`
- `bun typecheck`

If tests are required, use:

- `bun run test`

Do **not** use:

- `bun test`

That is an intentional repo-specific rule.

---

## When Unsure

Use this decision rubric:

- Does this make Workbench more folder-first?
- Does this make outputs or plans more visible?
- Does this keep the interface calm?
- Does this preserve provider-neutral product behavior?
- Does this keep important execution behavior visible and understandable?
- Does this respect the server/environment as the execution boundary where appropriate?
- Would a non-developer understand the result better?

If the answer to most of these is “no”, rethink the approach.

---

## Anti-Patterns

Do not:

- reintroduce T3 Code branding in user-facing surfaces
- turn the product into an IDE-first experience by default
- optimize for developer-only workflows at the expense of clarity
- bury important state transitions in logs only
- silently swallow provider runtime behavior
- implement server-owned/export/integration behavior purely in the browser when that breaks architectural boundaries
- mix unrelated product copy changes, mechanical refactors, and migration logic in one large diff
