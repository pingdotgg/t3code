---
name: setup-pstack
description: Configure pstack's per-role models and reasoning budget for this T3 environment. Use for $pstack:setup-pstack, configure pstack models, pstack budget, or changing pstack's model choices.
---

# Setup pstack

Write the models file at the absolute `<models>` path from `<t3_pstack>`. T3 resolves that file against this environment's providers and appends exact role targets to the next pstack invocation. Skills use those targets directly.

### 1. Inventory every provider and model

Call `orchestrator_capabilities` with `allModels: true`. It lists every usable instance, and a provider pool appears once under its pool instance ID with its members hidden. Use the pool ID as the instance, never a member. If a provider still returns `omittedModels`, its server predates `allModels`: list the rest with `search` on each family name. Models hidden in Settings never appear; when the user names a missing model, say it is hidden or not advertised, not unavailable. Record each model's ID, label, and advertised options. Never write a disabled instance, unadvertised model, option ID, or option value. If the tools remain unavailable after the harness's documented fallback, say `pstack needs the t3-code tools, which this session does not expose.` and stop. `inherit-parent` and `auto` always remain valid.

### 2. Load state and ask for a budget

Read `<models>`. Preserve its `# budget:` line and current choices. Drop roles absent from step 5, and report them. If the file is missing, start from the defaults below. A native harness's existing model sheet may seed a proposal only when the user identifies it; validate every choice against this environment's catalog.

Ask for a budget. Use the harness question tool if available; otherwise ask in plain text and end the turn. Name the recorded budget, or say that `large` targets `xhigh`. Offer these exact labels:

- `unlimited — max reasoning`
- `large — xhigh reasoning`
- `medium — high reasoning`
- `small — medium reasoning`

A budget-only request keeps every current seat, applies the effort rule in step 3, and goes to step 4.

### 3. Research, assign, and confirm

**(a) Research the models.** Profiles live in `model-profiles.md` beside `<models>`, one section per model ID, shared by every instance that offers it. Reuse a profile younger than 30 days. Each profile records:

- family: the maker, read from the ID and label.
- tier, from the maker's own positioning: flagship line `frontier`, mid line `strong`, small, mini, or flash line `fast`. Use `unknown` when the maker gives none.
- tool use: `reliable` only when the maker documents native tool calling for the model, `unreliable` when it documents none, otherwise `unproven`.
- cost: `free` when the label or instance says so, otherwise `unknown`. Never infer billing.
- context size, strengths, and weaknesses the maker states, each with its source URL, and the research date.

Group the unprofiled models by family and research them with `delegate_task`, `role: "research"`, at most 25 models per child and at most 6 children at a time, spread across the `how explorer` seats in `<t3_pstack>` (omit `target` when the role is missing). Start each brief with `Read <pstack>/skills/poteto-mode/worker.md before anything else.`, using the absolute pack path, then give the absolute pack and models paths. Each brief lists its model IDs and labels, asks for the fields above from maker documentation only, says "Record unknown rather than guess", and says "Do not edit files, commit, or push." Each completion wakes you. Write the returned profiles, list any model with no profile as `unknown`, and continue once every child has returned.

**(b) Assign seats across providers.** Shortlist candidates from the profiles:

- Judgment roles (`judgment and prose`, `hardest tasks`, `how explainer`, `why synthesizer`, `reflect judgment, divergent, synthesizer`) take `frontier` models.
- Code roles (`feature, refactoring`, `bug-fix`, `perf-issue`, `hillclimb`) take `frontier` or `strong` models with `reliable` tool use.
- Exploration roles (`how explorer`, `why investigators`, `reflect tooling`, `swarm workers`) take `strong` or `fast` models, and may add `unproven` or `free` seats to widen coverage, never as a role's only seat.
- Panels (`arena runners`, `architect runners`, `interrogate reviewers`) take the strongest model of each family, one seat per family, highest tier first, at most four seats.
- `arena cross-judge pool` takes `frontier` models, preferring families the runners do not use, otherwise the runner families' strongest.
- Every pool gets seats from at least two families when two qualify, best seat first.
- Every instance with a qualifying model holds at least one seat somewhere. Name any instance left out and why.
- `unreliable` and `unknown`-tier models never hold a seat.

For a choice between eligible models, check each shortlisted candidate's `modelGuidance` from the inventory. A matching brief has the candidate as the worker (`modelSelection`), the relevant options, `scope: "subagent"`, and the seat's task category. Coding scores cannot support a review seat. Being the judge (`evaluatorSelection`) supplies no evidence about doing the work.

For each shortlisted candidate missing that match, call `orchestrator_capabilities` with `search` set to its exact model ID before choosing. Reuse the result across roles. Weigh confidence and scored sample counts; compare scores only within the same judge and rubric. Honor explicit choices.

Explain each consequential choice in one sentence with the project observation and sample count. If evidence is missing or provisional, say what maker profile or user preference supports the choice. Keep project observations out of the shared profiles and models file.

On a repeat run, keep every working seat. Propose only additions, for a qualifying family or instance with no seat, and replacements for unavailable seats. Show each change beside the old value.

Find the advertised select option whose values contain at least two of `low`, `medium`, `high`, `xhigh`, `max`. Use its actual ID, including `thinking` or `variant` where advertised. Budgets target `max`, `xhigh`, `high`, or `medium` respectively. Set every concrete entry, in pools and panels, to the requested value or the highest advertised ladder value below it. With none, mark the entry as needing a choice. Aliases, models without an effort option, and explicitly chosen off-ladder settings stay unchanged. Never select off-ladder settings under a budget.

Do not choose a latency or priority option automatically. Write such an option only when the user explicitly selects it. Kept seats and budget changes preserve explicitly selected non-effort options; a new seat starts with none.

**(c) Show and confirm.** Show each family with its instances, tier, and tool-use rating, which instances hold seats, and all 17 roles with their seats and chosen options, marking unavailable entries and every change. Full profiles stay in the file. Let the user change any role to several models from any detected provider instance, plus `inherit-parent` and `auto` for the parent model. Arena runners, architect runners, and interrogate reviewers are panels that run every seat; all other roles are pools that pick one seat per spawn and spread simultaneous children across seats. A swarm model race still needs explicitly resolved arm targets.

### 4. Validate

Validate every concrete instance, model, option ID, and value against this run's catalog. Never replace an unavailable choice silently. Ask for a valid choice. Aliases always pass.

### 5. Write the models file

The following default role block is also the server's machine-readable catalog. Keep these labels and the first fenced block under this heading intact. These are selection defaults, not literal models-file entries; resolve them to advertised instances and option IDs before writing.

```
feature, refactoring: claude-opus-5-5-xhigh
bug-fix: claude-opus-5-5-xhigh
perf-issue: claude-opus-5-5-xhigh
hillclimb: claude-opus-5-5-xhigh
judgment and prose: claude-opus-5-5-xhigh
hardest tasks: claude-opus-5-5-xhigh
how explorer: grok-4.7-xhigh
how explainer: claude-opus-5-5-xhigh
why investigators: grok-4.7-xhigh
why synthesizer: claude-opus-5-5-xhigh
reflect tooling: grok-4.7-xhigh
reflect judgment, divergent, synthesizer: claude-opus-5-5-xhigh
arena runners: claude-fable-5-2-high, claude-opus-5-5-high, gemini-4-carbon-high
arena cross-judge pool: claude-opus-5-5-high, gemini-4-carbon-high
swarm workers: claude-opus-5-5-high
architect runners: claude-opus-5-5-xhigh, grok-4.7-xhigh
interrogate reviewers: claude-fable-5-2-high, claude-opus-5-5-high, gemini-4-carbon-high
```

Overwrite `<models>` with no frontmatter: comment lines, `# budget: <label> (<effort>)`, and one `role: value` line per role. Each value is a comma-separated list of entries: `inherit-parent`, `auto`, or `<instanceId>/<model> <optionId>=<value> ...`. Split instance from model at the first `/`; model IDs may contain more slashes. Booleans are `true` and `false`. `#` starts a comment. Only write options the user chose; T3 completes omissions from the provider's current defaults. Never write role lines into `AGENTS.md`, `CLAUDE.md`, or a harness rule folder.

### 6. Confirm

Say where the file was written and that it applies to the next pstack run in this environment. Do not use an older `<t3_pstack>` block for roles just changed. If the user asks to continue in this turn, refresh `orchestrator_capabilities` and validate the exact newly saved targets and options before delegating. Another environment needs its own setup because provider instances differ.

### 7. Offer a verification skill (optional)

Check for a project `verify-*` skill or another real-app driver. If missing, offer once to generate one through [create-verification-skill](../create-verification-skill/SKILL.md). On yes, read and follow that file. On no, continue without pushing.

### 8. Offer a formal verification skill (optional)

If the project has no formal verifier skill, offer once to generate one through [create-formal-verification-skill](../create-formal-verification-skill/SKILL.md). On yes, read and follow it. On no, continue.
