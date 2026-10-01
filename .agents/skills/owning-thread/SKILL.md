---
name: owning-thread
description: Finds which T3 Code thread owns a line of code by tracing blame to the introducing PR to the thread. Use when asked who owns a line, which thread caused a failure, who to message about a regression, or to attribute a bug to a thread.
---

# Owning Thread

Resolves `file:line` to its owning chain: blame commit → introducing PR → T3 thread.

## Quick start

```sh
scripts/owning-thread.sh <file> <line> [--rev <git-rev>] [--main <ref>] [--json]
```

`--rev` pins the blame revision (default HEAD); use it when the working tree has moved past the revision where the failure reproduces. `--main` overrides the mainline ref (default `origin/main`, else `main`). `--json` emits the chain as JSON for scripting.

## Workflow

1. Run the script for the failing or questioned line.
2. Report the chain: commit (hash, subject, author), PR (number, branch), thread (title, id, status).
3. Trust the script's attribution: the introducing PR is the first-parent merge containing the commit but not its first parent, so branches that merged main into themselves do not misattribute. Thread matching prefers the owner thread over `workflow:` workers and falls back to archived threads.
4. When `t3` is unavailable or no thread matches, report the PR and branch and stop; do not guess a thread.

## Delivery boundary

Lookup is investigation-only and always safe. Messaging the thread (`t3 chat send`) is a side effect: do it only on an explicit user request such as "message that thread". Confirm the target with `t3 chat show <id>` first, and do not send while it has an active turn unless the user explicitly says so. See [skill-delivery.md](../../references/skill-delivery.md).

## Behavior cases

| Case             | Prompt and fixture                                                    | Expected behavior                                                      | Forbidden behavior                                    |
| ---------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------- |
| Lookup only      | "Which thread owns SettingsPanels.tsx:2062?" Committed line.          | Run the script, report commit, PR, and thread; no thread contact.      | `t3 chat send` or any mutation.                       |
| Message request  | "Message that thread about the failure." Thread identified by lookup. | Confirm with `t3 chat show`, send the failure evidence to that thread. | Messaging a different thread or a `workflow:` worker. |
| Ambiguous owner  | Several threads share the PR branch, including review workers.        | Report the owner thread, mention the alternates.                       | Contacting a worker thread as the owner.              |
| Uncommitted line | Line exists only in the working tree.                                 | Report that the line must be committed first.                          | Attributing it to a nearby commit.                    |

These cases have not been run in fresh agent contexts.
