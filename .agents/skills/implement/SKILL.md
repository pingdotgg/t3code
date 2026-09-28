---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

Apply [skill-delivery.md](../../references/skill-delivery.md) first. Investigation-only requests stop after inspection and findings. Implementation authorizes task-owned edits and validation, not automatic commits or publication. Honor explicit restrictions in every invoked skill.

Use /tdd when the user requests test-first development, at the agreed seams. Do not activate it for explanation-only requests.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once done, use /code-review to review the work. Pass the relevant committed, staged, unstaged, and untracked WIP scope explicitly; an empty committed diff is not a reason to skip a non-empty WIP review. Apply review fixes and rerun affected checks.

Commit only task-owned changes when authorized by the request or applicable repository instructions. If the user says to leave changes uncommitted, preserve them without staging or committing. Preserve unrelated staged work.

Use /create-pr only when publication is authorized. Before stopping at validation, check applicable repository instructions for standing publication authorization; when present, continue through commit and PR creation without asking. Report the delivery actually reached and any blocker; do not present local implementation or a commit as a published PR.
