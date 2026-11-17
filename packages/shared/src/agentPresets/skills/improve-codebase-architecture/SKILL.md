---
name: improve-codebase-architecture
description: Review codebase modularity and test seams, compare interface designs,
  or stress-test a proposed architecture against domain language and ADRs.
---

# Architecture Review

Read relevant source, CONTEXT.md or CONTEXT-MAP.md, and ADRs when present. Use the project's vocabulary; missing domain documents are not a reason to halt or create boilerplate. Identify concrete friction: a change spread across unrelated files, duplicated rules, hidden ordering, leaky state, or tests that miss the real call pattern.

Prefer interfaces that hide meaningful complexity and concentrate related behavior. A smaller file or extra abstraction is not automatically an improvement. Read [LANGUAGE.md](LANGUAGE.md) and [DEEPENING.md](DEEPENING.md) when their terminology or dependency patterns clarify a decision.

For an audit, show affected files, evidence, proposed boundary/interface, tradeoffs, migration risk, and verification. If the user asks to implement an identified refactor, proceed within that scope; do not force a candidate-selection interview first. Revisit an ADR only when new evidence warrants it.

For competing designs, read [INTERFACE-DESIGN.md](INTERFACE-DESIGN.md). For an explicitly requested grilling session, ask one consequential question at a time, offer a recommendation, and inspect code for questions it can answer. Otherwise keep clarification proportional to the task.

Make the code tell the story: a clearer interface or name, a script that checks the rule, a test on the real call pattern, or a lint whose error names the fix. Do not write ADRs, CONTEXT.md entries, agent READMEs or other docs, and do not commit generated artifacts; propose vocabulary additions in your reply. Write a doc only when the user asks, following the project's convention.
