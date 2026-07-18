---
name: modify-with-patch-md
description: Make a deliberate downstream change while recording its intent. Use when customizing upstream-owned behavior in a T3 Code fork that contains PATCH.md.
---

# Modify with PatchMD

Make the requested change normally and keep its intent durable.

## Establish scope

1. Read `AGENTS.md` and root `PATCH.md`.
2. Confirm the change deliberately customizes upstream-owned behavior.
3. Reuse an entry for the same intent or choose a stable kebab-case ID.

Do not record formatting, generated files, lockfile churn, environment
configuration, ordinary dependency updates, or independent additions that
upstream cannot overwrite.

## Implement and record

Use T3 Code's existing architecture. Add or update one feature-centered entry
with `Status`, `Intent`, `Why`, `Behavior`, `Scope`, and `Reconstruction`.
Temporary fixes should include `Retire when`. Describe outcomes and constraints,
not source patches.

## Verify

Run every applicable command in `PATCH.md`'s Verification section. Re-read the
diff and entry together and fix any mismatch or failure caused by the change.

## Commit and report

When commits are authorized, keep the implementation and intent update in the
same logical commit. Otherwise leave both for the user's commit workflow. Never
push without approval. Report the behavior, entry, checks, and ambiguity.
