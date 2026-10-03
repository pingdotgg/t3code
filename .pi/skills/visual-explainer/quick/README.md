# Quick renderer

Quick mode moves repeated HTML and CSS out of the agent response. The agent emits a compact JSON spec. `render.mjs` validates it and creates one complete, self-contained HTML document.

Quick mode is opt-in. Use it only for `/generate-web-diagram --quick`, `/diff-review --quick`, `/plan-review --quick`, or `/project-recap --quick`. Use full mode if the requested design does not fit the schema or if validation or rendering fails.

## Pi

Call the existing `visual_explainer` tool with:

```json
{
  "action": "render_quick",
  "filename": "auth-flow-quick",
  "spec": {
    "title": "Authentication flow",
    "sections": [
      {
        "title": "Request path",
        "flow": {
          "nodes": [
            { "id": "browser", "label": "Browser" },
            { "id": "api", "label": "API", "tone": "positive" }
          ],
          "edges": [{ "from": "browser", "to": "api", "label": "token" }]
        }
      }
    ]
  }
}
```

## Other harnesses

Save the spec as JSON and run:

```bash
node ./quick/render.mjs spec.json ~/.agent/diagrams/auth-flow-quick.html
```

Use the `quick` directory relative to the installed visual-explainer skill. Open the result with the harness browser command. If the renderer exits with an error, continue with the normal full HTML workflow.

## Schema

`schema.json` is the authoritative JSON Schema. A spec has a `title`, optional `subtitle` and `summary`, and one or more `sections`. Each section can contain:

- `cards`: compact findings or concepts;
- `table`: columns and string rows;
- `risks`: severity-tagged risk items;
- `files`: paths, details, and change status;
- `steps`: ordered work or timeline items;
- `flow`: nodes and directed edges;
- `callouts`: notes, decisions, or warnings;
- `evidence`: a label, value, and optional source.

All agent text is HTML-escaped. Unknown properties, invalid enum values, bad flow references, and table rows with the wrong column count fail validation.
