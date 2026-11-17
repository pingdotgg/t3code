---
name: second-opinion
description: Get one independent opinion on a question, plan, design, or diff from a model on a different provider, briefed without your own conclusion. Use when the user asks for a second opinion, an outside view, or to check something with another model.
---

1. Pick the model: the strongest one `orchestrator_capabilities` lists on a provider other than yours. If no other provider is available, use a different model on yours and say so. A model the user names wins.
2. Write a neutral brief: the question, the facts and file paths it needs, and what a useful answer looks like. Leave out your own answer, your leaning, and any wording that suggests one.
3. Delegate it (in T3 Code: `delegate_task` with that target, `role: "review"`, and a read-only task). Wait for the result.
4. Report its opinion next to yours: where you agree, where you differ, and which one you would follow and why. Name the model it came from.

**Related:** for three opinions from three providers, use `council`. For a code diff reviewed in rounds until both sides agree, use `sol-loop`.
