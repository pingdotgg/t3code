---
name: council
description: "Bring in a council of strong models from different providers. Review mode reviews existing work in rounds until each member finds every criterion met. Build mode has each member build the same artifact, picks a base and grafts the best of the rest into it. Use when the user says 'council', asks for review or feedback from several models, or says 'arena this', or when one attempt at a non-trivial artifact would lock in the wrong shape."
---

# Council

Two modes. **Review** when the work exists and needs judging: a diff, a PR, a design, a question. It is the default when the user says "council" about something already written. **Build** when the artifact does not exist yet, or the user wants fresh shapes for it ("arena this", "build it three ways").

## The council

Both modes share these rules.

- **Members.** Three strong models, one from each of three providers, at high reasoning effort. If the user's instructions name members, use those. Otherwise pick the latest flagship model from each provider, for example Claude Opus, GPT Sol, and Gemini Pro. In T3 Code, resolve them with `orchestrator_capabilities` and start each with `delegate_task`, in parallel. Elsewhere, use the harness's subagent tools. If a member's model is unavailable, use the closest strong model from a provider the council does not already have, and say which one stood in. If you still cannot reach three providers, report it and run with the providers you have.
- **Rubric.** Before starting anyone, derive 3 to 6 concrete, gradeable criteria for what success looks like on this task. In Review the members judge against it. In Build only the judge and you see it; candidates see the task alone.
- **Brief.** Give each member the request and pointers to the context it needs, never your own conclusion, as `second-opinion` step 2 does. Divergence comes from the brief, not the model: in Build, give each member a different starting constraint.
- **Separation.** Each member gets its own output location: a git worktree where possible, otherwise `/tmp/council-<slug>/<member>/`, per the **separate-before-serializing-shared-state** principle (`~/.agents/skills/principle-separate-before-serializing-shared-state/SKILL.md`). Reviewers stay read-only.
- **Scope.** Do not let repeated rounds turn into scope creep. It is your job to keep scope limited.

## Review mode

Before the review, address outstanding PR comments, fix known issues, and run relevant checks, so the council sees the updated implementation; do not defer known fixes until reviews return. If the user wants to discard the implementation and explore new ideas, skip fixes to code being replaced.

Each member reviews read-only and judges every rubric criterion as met or not met, with evidence for each one that is not met. Count each full review pass as one round. A fresh review after fixes starts a new round.

Do not wait idle. When a result arrives, check its findings against the code at once and decide what to fix while the other members run. Do not edit files while a member still reviews the same checkout. If the user's instructions mark a member as non-blocking, do not wait for it; treat a late result as feedback and do not record its score.

Collect the responses and summarize the useful findings, disagreements, and recommended next steps. If you agree with a recommendation, make the change and start a fresh round. Stop when every member finds every criterion met, or when what remains is out of scope; say which.

If the work ends in a pull request, put the results in the PR description, before the model and harness line at the end. Each cell is the criteria met that round:

```markdown
## Council review

Rounds: 2

| Member | Round 1 | Round 2 |
| --- | --- | --- |
| Claude Opus | 3/5 | 5/5 |
| GPT Sol | 4/5 | 5/5 |
| Gemini Pro | 3/5 | 5/5 |
```

If a member gives no judgment, write `no score`. Do not invent one. If the PR is open, edit the description; do not post a comment for this. If there is no PR, put the same results in the final reply only.

## Build mode

Open a todolist with one entry per phase (Frame, Fan out, Cross-judge, Pick, Graft, Verify) before launching anything.

### Phase A: Frame

Every candidate gets the same prompt, so the prompt is the contract.

1. State the artifact each candidate is producing.
2. Derive the rubric, as [The council](#the-council) says. It is the picker's tool in Phase D.
3. Pick the runners: the council's three members, each with a different starting constraint. Raise the count only when the work genuinely covers separate design directions, and say in the report what N you chose and why. N above six is almost never the reason a bakeoff fails.
4. Give each candidate its own output location, as [The council](#the-council) says.

### Phase B: Fan out

Delegate to all N candidates at once, in the background (in T3 Code: `delegate_task`, with `isolation: "worktree"` for a candidate's own worktree), each with the task, the path to the shared grounding, its own output path, and instructions to produce the artifact and a short rationale naming the alternatives it considered and what it rejected.

If a candidate produces no output, proceed with N-1 and note the dropout.

### Phase C: Cross-judge

After all Phase B candidates complete, delegate to one read-only judge on a strong model from a provider other than yours. The judge must not be one of the runners. Its independence is the point. It sees the rubric and the candidates by path label, scores each criterion, and recommends a base with rationale. It runs in parallel with your reading in Phase D, not with the candidates themselves.

### Phase D: Pick a base

Read every candidate end to end before picking. Score each against the rubric criterion by criterion, not on holistic feel, and compare with the cross-judge. Agreement on the base confirms the pick. Disagreement means one of you is biased or the rubric was ambiguous. Read both rationales before deciding.

Pick the base a future maintainer can extend most easily without breaking invariants. When two feel tied, prefer the cleaner boundary or smaller API, per the Laziness Protocol.

### Phase E: Graft

Walk each losing candidate once more for what is worth porting into the base, usually one or two things per candidate, not most of it. Fold each graft in by hand, per the **redesign-from-first-principles** principle (`~/.agents/skills/principle-redesign-from-first-principles/SKILL.md`), so the result stays coherent under one mental model. Don't paste mechanically.

If the candidates converge on one shape, that is strong agreement. Note it and ship the consensus shape. No graft is needed. If they wildly diverge, Phase A was under-specified. Reframe and re-run rather than averaging the divergence.

### Phase F: Verify

Verify the synthesized artifact like any other output, per the **prove-it-works** principle skill. If verification finds a problem the council missed, either Phase A was wrong (re-frame and re-run) or a candidate caught it and you missed the graft (go back to Phase E). Don't paper over it.

### Outputs

One synthesized artifact, with a short synthesis note alongside naming the base and why, the cross-judge's verdict, each graft with its source candidate, what was rejected and why, any convergence or dropouts, and the verification result.
