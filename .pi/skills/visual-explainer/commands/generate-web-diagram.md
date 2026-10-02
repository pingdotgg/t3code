---
name: generate-web-diagram
description: Generate a standalone HTML diagram and open it in the browser
---

Load the visual-explainer skill and generate an HTML visual explainer for: $@

If `$@` contains the literal `--quick` flag, remove that flag from the topic, read `./quick/README.md` and `./quick/schema.json`, and emit a compact JSON spec instead of HTML. In Pi, call `visual_explainer` with `action: "render_quick"`, a descriptive filename, and the spec. In other harnesses, save the spec and run `node ./quick/render.mjs <spec.json> <output.html>` from the installed skill directory. If the topic does not fit the schema, validation fails, or rendering errors, continue with the full HTML workflow below. Without `--quick`, do not use quick mode.

Use the skill’s reference routing and final checklist. Pick a representation that fits the topic: Mermaid for connected flows/topologies; CSS cards for text-heavy explanations; tables for matrices; timelines for linear history.

Write to `~/.agent/diagrams/` with a descriptive filename and open the result in the browser. In Pi package installs, this is an explicit visual request: use `visual_explainer.prepare` when planning/context scouting helps, then `visual_explainer.render` with the complete HTML.
