# Make it yours

poteto-mode is one person's style. The playbooks, routing, and model roles underneath it work just as well with yours. This page covers generating a personal mode, capturing lessons from a session, fixing the repo so agents stop repeating mistakes, authoring a focused skill, and testing a skill change before you trust it.

Start smaller than you think. You don't need many skills on day one, or even this whole plugin. Prompt plainly, watch where agents fail, and add a skill or a check when the same failure shows up twice.

## Generate your own mode with `$pstack:automate-me`

```text
$pstack:automate-me
```

You don't describe your style, because [`$pstack:automate-me`](../../skills/automate-me/SKILL.md) reads it out of your history. It reads your recent T3 threads in the current project for repeated preferences, in how you like replies, delegation, verification, code, prose, and process, then asks you which patterns are really you. It drafts `.agents/skills/<your-name>-mode/SKILL.md` using `skill-creator` when available, otherwise direct Agent Skills authoring, runs the draft through [`$pstack:unslop`](../../skills/unslop/SKILL.md), and opens a PR from a worktree so you review it like any other change.

Run it again whenever your habits drift:

```text
$pstack:automate-me update my mode skill with everything since its last edit
```

Update mode mines only the history since the skill last changed. It keeps rules you haven't contradicted, revises the ones with new evidence, and adds sections only for new patterns.

## Capture a session's lessons with `$pstack:reflect`

Right after a task that taught you something, run:

```text
$pstack:reflect that took way too long. capture what we learned so the next run doesn't repeat it.
```

[`$pstack:reflect`](../../skills/reflect/SKILL.md) reads the transcript for durable lessons and uses parallel reviewers for a broad transcript. It sorts proposals into `Accepted`, `Rejected`, and `Backlog` and waits for your approval before any skill changes. Approve a proposal only if it would change a future decision. One weird session is an anecdote, not a rule.

## Fix the environment with `$pstack:correct`

When you correct agents for the same mistake again and again, the fix belongs in the repo, not in your next prompt. Rank the options by how well they hold:

1. Make the mistake impossible with architecture or a better data structure.
2. Block it with types, or with a lint or CI check whose error names the fix.
3. Catch it with a test.
4. Write it down as a doc or agent rule. Nothing fails when an agent skips a rule, so this comes last.

Human review isn't on the list. A reviewer who must catch the same mistake on every PR is the problem this fixes. [`$pstack:correct`](../../skills/correct/SKILL.md) does the work:

```text
$pstack:correct agents keep calling the database client directly instead of going through the repository layer
```

It reads recent commits, reverts, review comments, and comments that explain workarounds, then groups the mistakes into classes. A class counts once it has happened twice. It fixes the most frequent classes one commit each, at the highest level that works, and proves each new check fails on a real past mistake. It also keeps a table in the agent instruction file that pairs each rule with what enforces it, so a rule that nothing enforces shows up as a repeat. The reply lists each class with its evidence, the level chosen, and why a higher level didn't work.

Run it with no argument and it finds the classes from history on its own. `$pstack:reflect` and `$pstack:correct` split the work. `$pstack:reflect` improves skills from one session. `$pstack:correct` changes the repo so a mistake class can't come back. Pair it with `$pstack:architect` when the fix is a new boundary. [Run many projects in parallel](./07-overnight.md#run-many-projects-in-parallel) has a prompt that does both across a whole repo.

## Author a focused skill

When you already know the workflow you want to capture:

```text
$pstack:poteto-mode write a skill for verifying database migrations in this repo
```

Writing a skill matches the [Authoring or modifying a skill playbook](../../skills/poteto-mode/playbooks/authoring-a-skill.md), which routes through the `skill-creator` skill when available, otherwise direct Agent Skills authoring, validates the frontmatter and links, and ships the result through the Opening a PR playbook. Agent-facing prose has a higher bar than human prose, because an unhelpful sentence becomes an instruction some future agent follows. Let the playbook hold that bar rather than writing a `SKILL.md` freehand.

Two special cases have their own generators. A skill that must drive your app and prove behavior is a verification skill, so use [`$pstack:create-verification-skill`](../../skills/create-verification-skill/SKILL.md) and [`$pstack:maintain-verification-skill`](../../skills/maintain-verification-skill/SKILL.md) instead. A skill that checks a property of your code with a model checker, a proof, or another verifier is a formal verification skill, so use [`$pstack:create-formal-verification-skill`](../../skills/create-formal-verification-skill/SKILL.md) and [`$pstack:maintain-formal-verification-skill`](../../skills/maintain-formal-verification-skill/SKILL.md). [Verify and ship](./06-verify-and-ship.md#prove-a-property-with-a-formal-verification-skill) covers both kinds.

## Write docs to a standard with `$pstack:technical-writing`

Skills aren't the only prose you ship. For docs, RFCs, readmes, PR descriptions, and commit messages:

```text
$pstack:technical-writing review the readme changes
```

[`$pstack:technical-writing`](../../skills/technical-writing/SKILL.md) applies a layered standard. Its goal is prose that a tired engineer understands on the first read. It picks the document's mode first (tutorial, how-to, reference, or explanation), then works sentence by sentence: who does what, one thought per sentence, nothing readable two ways. Use it to review what you or an agent just wrote, or name it up front when you ask for a doc.

## Test a skill change blind

A skill edit affects every future session, so test it like the experiment it is. The same goes for adopting someone else's skill. Check that it makes the agent better on your work before you keep it.

```text
$pstack:poteto-mode run the eval playbook on this skill change. same task for both variants, candidates stay blind.
```

When a skill keeps missing and you know what it should do, change and test it in one task:

```text
$pstack:poteto-mode update the review skill so it flags missing migrations, and eval the change.
```

Asking for the eval up front keeps the edit honest. A fix written from one bad session tends to overfit that session, and over many edits the skill drifts. The eval catches the drift before it ships.

The [Eval playbook](../../skills/poteto-mode/playbooks/eval.md) is built around one failure mode, the observer effect. An agent that knows it's being evaluated behaves differently. So candidate agents get an organic-looking task in sanitized directories, never the words "eval" or "candidate", and never each other's existence. One judge scores all outputs under neutral labels, and chain-following gets graded from which files each candidate actually read, not from what it claims.

Read every output yourself before accepting the verdict. If you disagree with the judge, suspect the rubric before you suspect your judgment.

## Build a bot UI with `$pstack:make-bot-ui`

One situational skill is for Grok Bot users. [`$pstack:make-bot-ui`](../../skills/make-bot-ui/SKILL.md) builds a small page whose buttons wake a bot over a webhook routine. For example, you could swipe through a review queue and have each swipe ask the bot to act on that item. A server on your machine holds the webhook's sender key, so the key never reaches the browser or the chat. The skill also covers exposing the page on Tailscale.

**Pitfall:** don't edit a skill mid-task because it's misbehaving. Fix it in its own PR and keep the task moving. A skill edit that ships tangled into feature work is invisible to review and impossible to evaluate.

Next: [Recipes and pitfalls](./10-recipes-and-pitfalls.md).

## Capture maintainer and team conventions

Use [$pstack:automate-maintainer](../../skills/automate-maintainer/SKILL.md) for a supplied person or group. Use [$pstack:automate-team](../../skills/automate-team/SKILL.md) to discover the repository's active core first. Each collects attributable evidence, keeps private sources private, preserves disagreements, and validates against held-out reviews. A sync preserves these two custom skills.
