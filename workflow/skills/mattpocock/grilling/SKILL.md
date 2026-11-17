---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round, giving your recommended answer to each. Then wait for the user's answers before the next round.

Ask each round with your harness's structured question tool when it has one (in T3 Code it shows the user a question card and notifies them, where plain text could go unseen). One question per decision. Put the context the user needs in the question itself, since the card may hide your earlier text. Offer the real choices as options, your recommendation first and marked "(Recommended)". The user can always answer in their own words. When the frontier holds more questions than one call takes, ask the rest in further calls of the same round.

Fall back to plain text only when your harness has no such tool, or for a question that has no sensible set of choices. Format a text round like so:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

Word each text question so "yes" accepts your recommended answer.

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. For facts in external docs or APIs use the `research` skill; when a question is really "how should this look or behave", offer the `prototype` skill. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent with a fresh context window (in T3 Code: `delegate_task`) to find it; don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report; ask the rest of the frontier now. The _decisions_ are the user's: put each to them and wait. When the answer belongs to someone else, park that branch and offer `to-questionnaire` for that person.

When the plan coins or overloads a domain term, or the repo keeps a glossary, also use the `domain-modeling` skill.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.

**Related:** Once the plan is settled, offer `to-spec` for one feature or `wayfinder` for big, foggy work. Ask before switching skills.
