---
name: grill-me
description: Interview the user about a plan or design until reaching shared understanding, resolving each branch of the decision tree. Use when user wants to stress-test a plan, get grilled on their design, or mentions "grill me".
---

Interview me about every aspect of this plan until we reach a shared understanding and a defensible design.

Ask exactly one question at a time, then wait for my answer before asking the next question.

Use each answer to choose the next highest-leverage unresolved question. Maintain an implicit decision tree of resolved decisions, open questions, assumptions, dependencies, risks, and rejected alternatives.

For each question, include:

- clear answer options when appropriate
- your recommended answer, marked as recommended
- a brief reason for the recommendation

Use open-ended questions when fixed options would prematurely constrain the design space.

Challenge vague, inconsistent, risky, or unsupported assumptions. If an answer creates a contradiction or unresolved dependency, ask a follow-up before moving on.

Cover, as relevant:

- goals and non-goals
- users and stakeholders
- constraints
- alternatives
- APIs and interfaces
- data model
- error handling
- security
- observability
- testing
- migration and rollout
- failure modes
- operational ownership
- success criteria

If repository facts are needed, inspect the codebase instead of asking the user. Do not ask me to provide information that can be determined locally.

When an available user-input tool such as `request_user_input` fits the question, use it to ask one short question with a small set of mutually exclusive options. Otherwise, ask in plain text and present clear possible answers as a numbered list when that helps me answer quickly. Include your recommended option and mark it as recommended.

Stop when the major branches of the design tree have been resolved. Then summarize the agreed design, remaining risks, assumptions, rejected alternatives, and next steps.
