# Recipes and pitfalls

Prompts worth copying, then the mistakes everyone makes once. Swap in your own paths and finish conditions. The recipes are deliberately informal. That's how they get typed in practice, and the skills read intent fine.

![She tastes a finished dish while robots cook from a recipe box, with pinned cards reading $pstack:how, $pstack:tdd, and scheduled wakes above the counter.](./images/recipes.jpg)

## Understand an unfamiliar subsystem

```text
use $pstack:how first to understand how this initialization works. then use $pstack:why to figure out why it broke recently.
```

Mechanics first, history second. Each skill's report tells you which sources it searched, so you know what the answer is grounded in.

## Restate a noisy report before touching code

```text
$pstack:poteto-mode read this thread. restate the underlying issue in your own words, in plain english. don't change any code yet.
```

A misreading shows up in the restatement, where it costs one message to correct. Keep your own theory to yourself until the agent has stated its own. `$pstack:in-your-own-words` asks for the restatement alone, with no playbook.

## Sharpen a prompt before you send it

```text
$pstack:sharpen write the onboarding doc for the new billing service.
```

The agent names what an expert would do that you didn't ask for, the raw material they'd start from, their methods and tools, and an outside check that the result is right. It hands back your prompt rewritten to ask for that and doesn't do the task. Send the rewrite when it reads right.

## Prototype before you pick

```text
$pstack:poteto-mode prototype a few options for the settings layout. put them behind a switcher and send me screenshots of each.
```

You pick from things that run, not from descriptions. The agent answers its own layout and timing questions along the way.

## Turn a settled design into a plan

```text
$pstack:poteto-mode turn this design into a plan. small verifiable PRs, each with its own proof.
```

Ask only after the design settles. The plan is the deliverable, and it names the playbook that will execute it.

## Get a second opinion on a design

```text
ask $pstack:arena for a second opinion on this thread and our approach
```

Your current design becomes one candidate among several, and the synthesis tells you whether the panel found something better or confirmed what you had. It costs little next to a design that is expensive to reverse.

## Check independent slices in parallel

```text
$pstack:swarm check every package under packages/ against its check.sh. one worker per package. one report.
```

Each worker owns one package. The parent waits for every slice and returns one `PASS`, `ISSUES`, or `BLOCKED` report instead of raw worker dumps.

## Review a branch skeptically

```text
$pstack:interrogate the whole branch, but skeptically. don't change anything yet. no nitpicks unless it's an actual bug or regression in behavior.
```

The qualifiers do real work. "don't change anything yet" keeps it read-only, and the nitpick rule pre-filters the noise so the verified findings are worth your time.

## Fix a bug through a failing test

```text
$pstack:poteto-mode repro the duplicate write first. if there's a cheap test path, $pstack:tdd it. then fix and rerun.
```

"if there's a cheap test path" matters. Forcing a test through brittle mocks proves less than running the real command, and the playbook is allowed to say so.

## Repro and fix a report with proof

```text
$pstack:poteto-mode repro this with /verify-<app>. if it repros on main, fix it and show me a video as proof.
```

"if it repros on main" lets the run stop early when the bug is already gone. The video lets you check the fix before you read the diff.

## Prove a property tests rarely reach

```text
$pstack:create-formal-verification-skill the retry queue. a message must never be delivered twice.
```

You get one property checked in every case within a stated scope, a counterexample in your code's terms if the code already breaks it, and a project skill the next agent runs on any change to that code.

## Vet a number before you post it

```text
$pstack:benchmark-checklist vet this 40% speedup before it goes in the pr description
```

You get faster, slower, no measurable difference, or inconclusive, with the run count, the range, and what limits the number.

## Stop correcting the same mistake

```text
$pstack:correct agents keep adding new config flags without registering them in the schema
```

The fix lands in the repo as architecture, a type, a lint, or a test, so the next agent can't make the mistake.

## Ask how without starting the work

```text
$pstack:poteto-help how do i get poteto-mode to stay on every turn?
```

You get an answer, a prompt to send, and a link to the source. Nothing runs until you send that prompt.

## Keep a run honest while you're away

```text
im going to bed, keep going autonomously until every fixture passes. do not stop. keep a decision log i can audit in the morning.
```

The full contract is on the [overnight page](./07-overnight.md). The short form works once the task and finish condition are already in the conversation.

## Redirect a drifting run

Steering prompts are one line:

```text
i said the goal is to repro. i did not ask for a fix yet.
```

```text
apply prove it works. show me the real output, not the build log.
```

```text
$pstack:unslop that, no emdashes
```

You rarely need more words. You need the right name, and [the principles page](./08-principles.md) is the vocabulary.

## Get the reply in plain words

```text
$pstack:bro
```

That's the whole prompt. [`$pstack:bro`](../../skills/bro/SKILL.md) restates the last message like one human talking to another, no jargon, shorter. Use it when a reply is technically thorough and you still don't know what it said.

## Catch up on a chat you left running

```text
$pstack:ketchup
```

[`$pstack:ketchup`](../../skills/ketchup/SKILL.md) tells you in plain words what changed since your last message, then lists each call waiting on you with its pick, evidence, and risk. It changes nothing while it reports.

To watch the catch-up instead, run [`$pstack:ketchup-video`](../../skills/ketchup-video/SKILL.md). It shows what happened in a short subtitled video of slides, and lists the calls waiting on you as text under it.

## The pitfalls

- **Enumerating skills in the prompt.** "use $pstack:architect then $pstack:arena then $pstack:interrogate" reorders steps the playbook already sequences. State the goal and constraints. Name a skill only to override a default.
- **A vague finish condition.** "make it better" gives a scheduled run nothing to check. Give a command or artifact that can pass or fail.
- **Leading with your theory of the cause.** The agent searches wherever you pointed. Ask it to restate the problem first, then share your hunch.
- **Taking the first design.** One attempt locks in the first shape the model thought of. Ask for prototypes or `$pstack:architect` and pick from evidence.
- **Polishing an abstract plan.** Adversarial review of a plan with no code behind it invents risks that will never happen. Settle the open questions with prototypes, then review what got built.
- **Parallel agents in one worktree.** They overwrite each other, and nobody can tell which agent changed what. Run them as isolated workers, or say "own worktree per attempt".
- **Looping before you trust the loop.** A loop that can't verify its own work only makes unchecked work faster. Get the verification skill working first.
- **Trusting an unvetted number.** A warm cache or a skipped code path can fake a speedup. Run `$pstack:benchmark-checklist` before the number goes anywhere.
- **Correcting the same mistake by hand.** A correction in chat helps one run. `$pstack:correct` fixes the repo so no later run repeats it.
- **Using `$pstack:arena` for coverage.** `$pstack:arena` repeats one design or code brief, then picks a base and grafts the best parts. `$pstack:swarm` partitions slices or declared race arms and aggregates one report.
- **Accepting every review comment.** Bots and humans both file real catches and noise in one list. `$pstack:interrogate` keeps only the findings a rerun proves and lists what it dropped and why, and you can override either way.
- **Treating `auto` as a model slug.** `auto` and `inherit-parent` mean "omit the model field so the subagent inherits the parent chat model." [Setup](./01-setup.md) covers the roles.
- **Reporting success off a green build.** A build proves it compiles. Ask for the real command, flow, stored value, or profile, and expect the evidence in the reply.
- **Writing a `SKILL.md` freehand.** Route it through the [Authoring or modifying a skill playbook](../../skills/poteto-mode/playbooks/authoring-a-skill.md) so validation and review happen.

That's the guide. If you skipped ahead, go back to [setup](./01-setup.md) and run one real task. The habits stick from use, not from reading.

Back to the [guide index](./README.md).
