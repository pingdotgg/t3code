# Starting map

Trailhead for agents working in this repository. Read the present routes you need; do not load everything up front.

## Who and where

1. Call `t3_project_orient` once for identity (project, cwd, thread) and which of these routes exist.
2. Read `README.md` for what T3 Code is.
3. Read `docs/internals/overview.md` for how the pieces fit (architecture).
4. Read `AGENTS.md` for working rules (glossary, verifying, taste). Prefer the section that matches the task over the whole file.
5. If the task touches an area with its own guide (`docs/user/`, `docs/internals/`, a package `README.md`), read that before changing it.
6. Contribution shape: `CONTRIBUTING.md`.

## Suggested routes by question

| Question                         | Route                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| Where does this behavior belong? | `docs/internals/overview.md`, then the owning package under `apps/` or `packages/` |
| How do providers and turns work? | `docs/internals/providers.md`                                                      |
| How should I test this?          | `AGENTS.md` Verifying; `docs/internals/testing.md`                                 |
| How do MCP tools reach agents?   | `apps/server/src/mcp/`                                                             |
| How do I contribute?             | `CONTRIBUTING.md`                                                                  |

## When the map runs out

- Search the code before inventing an answer.
- If `.agents/ROSTER.md` is present, read it for who knows the area.
- If a needed map is missing, say so so the next agent gets a better one.
