# Memory capture

Runs the production knowledge extractor against authored examples from the November 2026 memory-quality audit and TraceDecay's session-reflector rules. It checks that useful corrections, scoped decisions with reasons, and reusable repairs survive, while task limits, code descriptions, temporary tool failures, coordinator instructions and unsupported causal claims do not become standing memories.

```sh
cd evals
pnpm memory-capture --model morph-kimik31 --samples 1 --case code-description --out runs/memory-smoke
pnpm memory-capture --model morph-kimik31 --out runs/memory-before
pnpm memory-capture --model morph-kimik31 --out runs/memory-after --baseline runs/memory-before/results.json
```

`--model gpt-6-luna` uses the local Codex subscription. Morph uses the free endpoint configured as described in [MCP tool use](../mcp-tool-use/README.md). No judge or agent task runs: each sample makes one extraction call, 39 for the complete suite with the default three samples per case. Calls are sequential; token cost is not reported by this runner.

The runner imports the production generator and prompt. `--case <ids>` restricts cases. `results.json` contains each proposed memory, citations and grading failures; inspect the text as well as the counts. A case passes only when a majority of samples passes. The optional baseline is retained beside results for comparison. These authored cases are regression checks, not an estimate of precision across existing project memories.

Add a case with its source, exchange, expected memory count, required content and exclusions. Keep user data out of fixtures. `grade.test.ts` tests the grader. Explicit agent saves are covered separately by `intelligence-remember-saves-directly` and `intelligence-remember-reason-and-scope` in the MCP tool-use eval.
