---
name: rmslop
description: Removes AI-generated code slop from the branch diff. Use when the user asks to clean up AI slop, de-slop a diff, or tidy a branch before creating a PR.
---

# Remove Slop

Check the diff against the base branch (committed range plus uncommitted changes), and remove all AI-generated slop introduced in this branch.

This includes:

- Extra comments that a human wouldn't add or is inconsistent with the rest of the file
- Extra defensive checks or try/catch blocks that are abnormal for that area of the codebase (especially if called by trusted / validated codepaths)
- Casts to any to get around type issues
- Any other style that is inconsistent with the file
- Unnecessary emoji usage

## Useful comments only

Keep a comment only when it explains what the code cannot show: a
non-obvious why, a contract the reader must honor, or a trap that looks
correct but is not. Remove comments that restate the code, narrate obvious
behavior, or preserve review-thread explanations once the change has landed.
Prefer one line; a paragraph must earn its length with a decision a future
reader could otherwise reverse.

Only touch changes introduced in this branch; do not reformat or refactor surrounding code. Report at the end with only a 1-3 sentence summary of what you changed.

Ported from [Hona/opencode](https://github.com/Hona/opencode/blob/main/.opencode/command/rmslop.md).
