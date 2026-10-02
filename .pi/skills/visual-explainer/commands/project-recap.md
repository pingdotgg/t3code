---
name: project-recap
description: Generate a visual project recap for context switching
---

Load the visual-explainer skill and generate a self-contained HTML project recap.

## Quick mode

Only use quick mode when `$@` contains the literal `--quick` flag. Remove the flag before interpreting any recap arguments. Complete the same project research and verification below, then read `./quick/README.md` and `./quick/schema.json` and express the recap as a compact spec. In Pi, call `visual_explainer` with `action: "render_quick"`. In other harnesses, run the local `./quick/render.mjs` fallback. If the recap does not fit the schema, validation fails, or rendering errors, generate complete HTML and use the normal render flow. Without `--quick`, preserve full HTML behavior.

## Data gathering before HTML

Read project identity files (`README`, changelog, package/build files), top-level tree, current git status, recent commits, unmerged/stale branches, TODO/FIXME in recent files, progress/todo memory if present, and key entry points/source files. Focus on what a returning developer needs to rebuild the mental model.

## Verify before generating

Cite command output or file:line evidence for project state, module/function/type names, recent activity, current blockers, and next-step claims. Do not fabricate momentum or rationale.

## Required page sections

1. Project identity: what this repo is, stack, entry points.
2. Architecture snapshot: Mermaid or hybrid diagram of current conceptual modules.
3. Recent activity: grouped narrative, not raw log.
4. Current state: uncommitted work, branches, TODOs, known blockers.
5. Mental model map: key modules, data flow, command/test/deploy paths.
6. Risks and cognitive debt: hotspots and gotchas.
7. Useful commands and files.
8. Likely next steps, based only on evidence.

Use responsive nav. Use compact reference tables for file maps and commands. Follow the skill’s Mermaid, overflow, and delivery rules.

Write to `~/.agent/diagrams/` and open in browser.
