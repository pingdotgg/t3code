# Design before you write code

One attempt at a hard design locks in the first shape the model thought of. `$pstack:architect` settles types and boundaries before implementation. `$pstack:arena` runs several attempts at the same brief and merges the best parts. `$pstack:interrogate` has other models try to break the result. When the job is coverage rather than design synthesis, `$pstack:swarm` fans out slices or races and aggregates their results.

The two most common design mistakes are taking the agent's first design and polishing a plan that no code has tested. This page fixes both. You plan through code. Prototypes answer the open questions, a README or tutorial sets the target, and the written plan comes last.

![Three robots draft competing bridge models at their own tables under $pstack:architect, $pstack:arena, and $pstack:interrogate panels, while a judge robot with a clipboard inspects skeptically.](./images/design.jpg)

## Settle the shape with `$pstack:architect`

```text
$pstack:architect design the import pipeline before writing any code. i care most about how callers use it.
```

[`$pstack:architect`](../../skills/architect/SKILL.md) traces every system the change touches first. Then it sketches two different shapes, each with types, signatures, and module boundaries, and picks the one where each piece of state has one owner, each task has one way to do it, and callers need to know least. For a large or contested design, it runs `$pstack:arena` with the configured architect panel. If you want to see the design before any code, say so in the prompt.

The design isn't sacred once code starts. If the same workaround keeps coming back, `$pstack:architect` redesigns instead of patching around it.

## Fan out attempts with `$pstack:arena`

```text
$pstack:arena take my prompt to the arena verbatim. i want to compare their proposals with yours.
```

[`$pstack:arena`](../../skills/arena/SKILL.md) is the general tool underneath. N subagents attempt the same design or code brief in parallel, each writing to its own worktree or directory. A read-only judge from a different model vendor scores every candidate against a rubric. When no model from another vendor can run, the coordinator skips the judge and picks the base itself. The coordinator reads each candidate end to end, picks a base, grafts in the best ideas from the losers, and verifies the result.

```mermaid
flowchart LR
    A[One task] --> B[Configured panel]
    B --> C[Candidate 1]
    B --> D[Candidate 2]
    B --> E[Candidate N]
    C --> F[Cross-judge]
    D --> F
    E --> F
    F --> G[Pick a base]
    G --> H[Graft the best parts]
    H --> I[Verify]
```

The panel comes from your [`$pstack:setup-pstack`](../../skills/setup-pstack/SKILL.md) configuration, and you can adjust it per task. Ask for more candidates when the decision matters, fewer when it doesn't:

```text
$pstack:arena this, 5 candidates. the cache key format is expensive to change later.
```

## Cover slices and races with `$pstack:swarm`

```text
$pstack:swarm check every package under packages/ against its check.sh. one worker per package. one report.
```

[`$pstack:swarm`](../../skills/swarm/SKILL.md) fans N workers across independent slices, coverage matrices, gauntlet lanes, exploration partitions, or declared race arms. Each worker gets its own scope and check, then reports `PASS`, `ISSUES`, or `BLOCKED`. The parent waits for the workers and returns one compact report with any gaps or dropouts.

Reach for it when parallelism buys coverage or lets independent checks race. `$pstack:arena` gives every worker the same design or code brief, then picks a base and grafts the best parts. `$pstack:swarm` covers slices or runs a race with a selection rule declared up front. It does not use the base-selection and grafting ceremony.

## Break it with `$pstack:interrogate`

```text
$pstack:interrogate the whole branch, but skeptically. no nitpicks unless it's an actual bug or regression.
```

[`$pstack:interrogate`](../../skills/interrogate/SKILL.md) gives the change and its intent to adversaries on the configured models, and each tries to break it with a run against the real code. Adversaries find different failures. A finding survives only when rerunning its command shows a failure that breaks the intent. The report lists every verified finding with the adversaries that found it, then what each adversary dropped and why, and applies nothing.

Read the Dropped list too. You can override the verdict.

## Prototype instead of debating

Never take the first design. Ask for a few, and pick from evidence you can see:

```text
$pstack:poteto-mode prototype a few options for the new dropdown menu. take screenshots or videos for me to compare.
```

The [Prototype playbook](../../skills/poteto-mode/playbooks/prototype.md) builds throwaway sketches in a scratch directory, puts the variants behind one switcher, drives each one, and captures screenshots or timings. It also works for behavior and algorithms, not just UI. Prototypes are planning with code. They let the agent answer its own open questions by running something instead of asking you, and they leave room for an option you wouldn't have thought of.

The same idea scales up to a real design. Pair `$pstack:architect` with prototypes and keep a review gate:

```text
$pstack:poteto-mode we need rate limiting for external webhooks. $pstack:architect it first, and answer open questions with prototypes. let me review before proceeding.
```

Don't spend adversaries on an abstract plan. `$pstack:interrogate` drops every finding a run does not prove, so a plan with no code behind it gives them little to break. Let prototypes settle the questions, then review what got built.

## Write the README first for shared code

For a package or API that other code will use, start with the doc a user would read:

```text
$pstack:poteto-mode write a tutorial for how i would use the new config package first. then $pstack:teach me why it beats the current one.
```

Writing the tutorial first forces the caller's view. You describe the API to a hypothetical user and work back to the implementation. The doc also becomes a concrete target the agent checks its own work against. Name [`$pstack:technical-writing`](../../skills/technical-writing/SKILL.md) when the doc itself matters, so a tutorial stays a tutorial instead of drifting into reference and explanation at once.

## Plan after the design settles

pstack has no planning skill, on purpose. When you do want a written plan, ask for it once the design is settled:

```text
$pstack:poteto-mode turn this design into a plan. small verifiable PRs, each with its own verification steps.
```

The [Multi-phase plan playbook](../../skills/poteto-mode/playbooks/multi-phase-plan.md) settles any remaining open questions by prototype, then writes one section per PR, each ending in proof that the change works. A passing test suite alone doesn't count as that proof. The plan is the deliverable. The playbook doesn't implement it, and execution starts only when you say go.

For a migration, state the bar in the prompt:

```text
$pstack:poteto-mode plan the migration of our ui library to the new styling system. small verifiable PRs, each with visual regression checks. the result must match the original exactly, bugs included.
```

"bugs included" keeps the migration from quietly fixing things on the way, which would make the old and new output impossible to compare. For a project that spans many days, you can commit the plan to the repo for a while so other agents see the work in progress. Delete it when the work lands.

## How much design work does a task deserve?

You might be wondering whether every change needs this. No. Most changes need none of it. A rough ladder:

- A small, finished change you're unsure about needs `$pstack:interrogate` alone.
- A change that crosses function boundaries or moves ownership earns `$pstack:architect`, which brings `$pstack:arena` with it when the design is large or contested.
- A standalone decision where independent attempts would help, like naming, formats, or an algorithm, is `$pstack:arena` directly.
- A coverage matrix, set of parallel checks, or race with declared arms is `$pstack:swarm`.
- An open question you could answer by running something, like a layout, a timing, or an approach, gets a prototype, not a debate.
- A contested design that's expensive to reverse gets `$pstack:architect`, then `$pstack:interrogate` before shipping.
- Work that spans several PRs gets a plan, written after the design settles.

`$pstack:poteto-mode` already applies this ladder. Boundary-crossing work triggers `$pstack:architect` on its own, so you reach for these directly mainly when you want more or less scrutiny than the default.

Next: [Build and clean the change](./05-build-and-clean.md).
