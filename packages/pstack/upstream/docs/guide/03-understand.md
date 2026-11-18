# Understand the code before changing it

Editing code you don't understand is how subtle regressions ship, and that's as true for the agent as for you. Agents usually fail in one of two ways. They misread what you want, or they don't have the context to do the work right. [What goes in a prompt](./02-poteto-mode.md#what-goes-in-a-prompt) handles the first. This page handles the second.

pstack gives you four ways in. `$pstack:how` explains what the code does now. `$pstack:why` digs up the reasons it's shaped that way. `$pstack:teach` blends both into one explanation. `$pstack:recall` rebuilds your own recent context on a topic. Each one also makes the agent explain itself in words you can check. That's how you supervise an agent that may know the code better than you do.

![A detective studies a machine blueprint with a magnifying glass while robots fetch case files; the evidence board behind her links clues under $pstack:how and $pstack:why.](./images/understanding.jpg)

## Start with a read-only investigation

When the cause is unclear, ask for findings, not a fix:

```text
$pstack:poteto-mode investigate why background jobs time out every few hours. give me what we know, what data you used, and your best hypotheses. don't change any code yet.
```

"don't change any code yet" routes this to the [Investigation playbook](../../skills/poteto-mode/playbooks/investigation.md). It traces the code, adds `$pstack:why` for questions about motivation, and returns a cited explanation. For a choice between options, it returns a recommendation with a trade-offs table. Asking "what data you used" makes the agent separate its evidence from its guesses. When the findings point at a fix, start the fix as a new task.

## Trace behavior with `$pstack:how`

```text
$pstack:how do we dedupe notifications? is there an n+1 when we look up subscribers?
```

Ask the question you actually have. [`$pstack:how`](../../skills/how/SKILL.md) reads the code and answers at the level of a senior engineer onboarding you onto the subsystem, with the runtime flow, the key types, and the non-obvious parts. For a focused question, one research delegate explores the code and writes the explanation. For a broad subsystem, researchers trace separate parts first.

## Dig up history with `$pstack:why`

```text
$pstack:why was the retry limit set to five? does the reason still hold?
```

[`$pstack:why`](../../skills/why/SKILL.md) answers from the record, not the code. It reads the commits and PR discussions that introduced the code and each later change, and looks at other sources when that trail is thin. The answer cites what the authors wrote, marks the agent's own inferences as inferences, and says what the record does not answer, because "nobody wrote down why" is itself an answer.

The two compose naturally. `do why first then how` is a good prompt when you suspect the history explains the mess.

## Actually understand it with `$pstack:teach`

```text
$pstack:teach me how this PR changes retries. convince me it fixes the cause and not the symptom.
```

[`$pstack:teach`](../../skills/teach/SKILL.md) is for when a summary isn't enough. It runs `$pstack:how` and `$pstack:why`, for a small change maybe just one of them, and weaves the findings into a plain explanation that builds up diagram by diagram. The "convince me" framing is worth reusing. It turns the explanation into an argument you can test instead of a tour.

It works on the agent's own choices too:

```text
$pstack:teach me why you implemented it this way and not with a queue. what did you trade off, and why?
```

Teaching helps the agent as much as you. An agent that has to explain its work must read the code and back each claim with evidence, instead of stating it confidently and moving on.

## Rebuild your own context with `$pstack:recall`

```text
$pstack:recall catch me up on the export work from last week
```

[`$pstack:recall`](../../skills/recall/SKILL.md) mines your own recent chats plus the shared record (issues, prior fixes, errors still firing) and hands back a brief on where things stand and what's next. Your old chats hold context that a fresh agent lacks, so start new work on an old topic by loading it first, then hand over the new input:

```text
$pstack:recall my work on the virtualized list from yesterday, then read this bug report.
```

If you want to resume one specific chat, that's the Session pickup playbook below, not `$pstack:recall`.

## Take over prior work with Session pickup

When another agent (or you, last week) left a branch mid-flight:

```text
$pstack:poteto-mode take over this branch. read the decision log, figure out what's done, and continue from there. don't redo finished work.
```

The [Session pickup playbook](../../skills/poteto-mode/playbooks/session-pickup.md) treats the prior trail as authoritative. It reconstructs the branch state and decisions, names the resume point, and verifies inherited claims against the original goal instead of re-deriving everything from scratch.

**Pitfall:** don't skip this page's skills because "the agent will read the code anyway." An agent that starts editing without a traced model tends to fix the symptom at the first plausible spot. `$pstack:how` first is cheaper than the second bug.

Next: [Design the change](./04-design.md).
