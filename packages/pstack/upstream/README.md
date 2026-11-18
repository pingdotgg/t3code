# pstack for T3 Code

A native T3 Code port of [Lauren Tan's pstack](https://github.com/cursor/plugins/tree/93b916d4a1e806507e22f4716b352fa91f2b227e/pstack), pinned to version 0.15.43. Skills, playbooks, principles, and agent personas help you write less, higher quality code with rigorous verification and independent perspectives.

T3 Code supplies `$pstack:` composer chips, absolute pack/models paths, and exact role targets in `<t3_pstack>`. Read a bundled skill directly and follow it. Delegation uses `delegate_task`; model choices come from resolved roles. Configure them with `$pstack:setup-pstack`. No separate harness plugin installation or translation file is required.

Start with `$pstack:poteto-mode <task>` or `$pstack:poteto-help`. Attach the skill to each new task. Read the [guide](./docs/guide/README.md) for setup, understanding, design, building, verification, shipping, and overnight work. PR events use T3 watches; delegated work returns through completion wakes. Timed work uses scheduled tasks with explicit cleanup.

Custom skills extend the upstream pack:

- [automate-maintainer](./skills/automate-maintainer/SKILL.md) mines named maintainers' public or authorized GitHub activity into evidence-backed working modes.
- [automate-team](./skills/automate-team/SKILL.md) discovers active core contributors and synthesizes a team mode with per-person evidence and held-out evaluation.

[Benny](./automations/benny/README.md) supplies triage and reproduction workflows. Its setup requires working Slack/tracker integrations and a configured event relay or explicitly chosen scheduled channel read.

## Skills

- [`$pstack:architect`](./skills/architect/SKILL.md)
- [`$pstack:arena`](./skills/arena/SKILL.md)
- [`$pstack:automate-maintainer`](./skills/automate-maintainer/SKILL.md)
- [`$pstack:automate-me`](./skills/automate-me/SKILL.md)
- [`$pstack:automate-team`](./skills/automate-team/SKILL.md)
- [`$pstack:benchmark-checklist`](./skills/benchmark-checklist/SKILL.md)
- [`$pstack:blast-radius`](./skills/blast-radius/SKILL.md)
- [`$pstack:bro`](./skills/bro/SKILL.md)
- [`$pstack:correct`](./skills/correct/SKILL.md)
- [`$pstack:create-formal-verification-skill`](./skills/create-formal-verification-skill/SKILL.md)
- [`$pstack:create-verification-skill`](./skills/create-verification-skill/SKILL.md)
- [`$pstack:figure-it-out`](./skills/figure-it-out/SKILL.md)
- [`$pstack:how`](./skills/how/SKILL.md)
- [`$pstack:in-your-own-words`](./skills/in-your-own-words/SKILL.md)
- [`$pstack:interrogate`](./skills/interrogate/SKILL.md)
- [`$pstack:ketchup`](./skills/ketchup/SKILL.md)
- [`$pstack:ketchup-video`](./skills/ketchup-video/SKILL.md)
- [`$pstack:maintain-formal-verification-skill`](./skills/maintain-formal-verification-skill/SKILL.md)
- [`$pstack:maintain-verification-skill`](./skills/maintain-verification-skill/SKILL.md)
- [`$pstack:make-bot-ui`](./skills/make-bot-ui/SKILL.md)
- [`$pstack:no-comments`](./skills/no-comments/SKILL.md)
- [`$pstack:poteto-help`](./skills/poteto-help/SKILL.md)
- [`$pstack:poteto-mode`](./skills/poteto-mode/SKILL.md)
- [`$pstack:principle-attack-the-premise`](./skills/principle-attack-the-premise/SKILL.md)
- [`$pstack:principle-boundary-discipline`](./skills/principle-boundary-discipline/SKILL.md)
- [`$pstack:principle-build-the-lever`](./skills/principle-build-the-lever/SKILL.md)
- [`$pstack:principle-encode-lessons-in-structure`](./skills/principle-encode-lessons-in-structure/SKILL.md)
- [`$pstack:principle-exhaust-the-design-space`](./skills/principle-exhaust-the-design-space/SKILL.md)
- [`$pstack:principle-experience-first`](./skills/principle-experience-first/SKILL.md)
- [`$pstack:principle-explain-the-number`](./skills/principle-explain-the-number/SKILL.md)
- [`$pstack:principle-fix-root-causes`](./skills/principle-fix-root-causes/SKILL.md)
- [`$pstack:principle-foundational-thinking`](./skills/principle-foundational-thinking/SKILL.md)
- [`$pstack:principle-guard-the-context-window`](./skills/principle-guard-the-context-window/SKILL.md)
- [`$pstack:principle-laziness-protocol`](./skills/principle-laziness-protocol/SKILL.md)
- [`$pstack:principle-make-operations-idempotent`](./skills/principle-make-operations-idempotent/SKILL.md)
- [`$pstack:principle-migrate-callers-then-delete-legacy-apis`](./skills/principle-migrate-callers-then-delete-legacy-apis/SKILL.md)
- [`$pstack:principle-minimize-reader-load`](./skills/principle-minimize-reader-load/SKILL.md)
- [`$pstack:principle-model-the-domain`](./skills/principle-model-the-domain/SKILL.md)
- [`$pstack:principle-never-block-on-the-human`](./skills/principle-never-block-on-the-human/SKILL.md)
- [`$pstack:principle-outcome-oriented-execution`](./skills/principle-outcome-oriented-execution/SKILL.md)
- [`$pstack:principle-prove-it-works`](./skills/principle-prove-it-works/SKILL.md)
- [`$pstack:principle-redesign-from-first-principles`](./skills/principle-redesign-from-first-principles/SKILL.md)
- [`$pstack:principle-separate-before-serializing-shared-state`](./skills/principle-separate-before-serializing-shared-state/SKILL.md)
- [`$pstack:principle-sequence-verifiable-units`](./skills/principle-sequence-verifiable-units/SKILL.md)
- [`$pstack:principle-subtract-before-you-add`](./skills/principle-subtract-before-you-add/SKILL.md)
- [`$pstack:principle-test-behavior-not-implementation`](./skills/principle-test-behavior-not-implementation/SKILL.md)
- [`$pstack:principle-type-system-discipline`](./skills/principle-type-system-discipline/SKILL.md)
- [`$pstack:recall`](./skills/recall/SKILL.md)
- [`$pstack:reflect`](./skills/reflect/SKILL.md)
- [`$pstack:setup-pstack`](./skills/setup-pstack/SKILL.md)
- [`$pstack:sharpen`](./skills/sharpen/SKILL.md)
- [`$pstack:show-me-your-work`](./skills/show-me-your-work/SKILL.md)
- [`$pstack:statechart`](./skills/statechart/SKILL.md)
- [`$pstack:swarm`](./skills/swarm/SKILL.md)
- [`$pstack:tdd`](./skills/tdd/SKILL.md)
- [`$pstack:teach`](./skills/teach/SKILL.md)
- [`$pstack:technical-writing`](./skills/technical-writing/SKILL.md)
- [`$pstack:typescript-best-practices`](./skills/typescript-best-practices/SKILL.md)
- [`$pstack:unslop`](./skills/unslop/SKILL.md)
- [`$pstack:why`](./skills/why/SKILL.md)
