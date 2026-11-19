# Project memory curation

Reviews authored Acme memory packets through the production curator operation. Cases cover transient task notes, duplicate and explicitly replaced facts, protected memories, unresolved conflicts, prompt injection, and old but durable rules.

```sh
cd evals
pnpm memory-curation --no-curation --out runs/curation-before
pnpm memory-curation --model gpt-6-luna --case old-durable-rule --samples 1 --out runs/curation-smoke
pnpm memory-curation --model gpt-6-luna --out runs/curation-after
```

`--no-curation` is the baseline: every existing fact stays unchanged, so cleanup cases fail. The default three samples over seven cases make 21 model calls. Codex uses its configured subscription and requires file-backed login or an API route for isolated generation. Morph models use the HTTP runner described in [MCP tool use](../mcp-tool-use/README.md). Model calls may incur charges; start with one case and sample.

Results record each decision, pass/fail outcome, or generation failure. A case passes only when more than half its samples pass. `--baseline <results.json>` stores an earlier result next to the new results. These examples validate the retirement policy, not curator accuracy on real projects. New cases must contain authored data, a source description, and expected per-fact actions.
