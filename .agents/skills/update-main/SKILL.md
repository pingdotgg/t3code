---
description: Update current branch with changes from main, report on new features and altered behaviors.
name: update-main
---

Study @CUSTOMIZED.md.

Your task is to spawn a subagent on this branch. **You do not load any mentioned skills yourself, you only instruct the subagent towards the mentioned skills.**

You are to instruct the subagent in several steps, provide it instructions one step at a time, and wait for the subagent to report back before providing the next step's instructions. **You do not validate any work yourself, your only task is to orchestrate the subagent's work and ensure it reports back with the requested information.**

The subagent only requires information for the current step at any given time, without contextual overall process status or that there may be future steps. The subagent is working alone in the branch.

**Step 1**: Instruct the subagent to study @CUSTOMIZED.md, to treat it as the current inventory of fork-specific behavior, conflict-prone files, and customizations that may become redundant when upstream adds equivalent features. The subagent is then to fetch and merge `main` branch from `upstream` remote onto current branch, preserving this fork's intentional customizations without blocking new upstream behavior.

Instruct it to remember incoming changes have been purposefully merged, the ongoing branch work is accessory and any conflicts should be resolved by working our changes around the incoming ones as necessary. Also the subagent must run the relevant validation for touched areas.

The subagent should update `CUSTOMIZED.md` before finishing:

- Update the generated-from refs, ahead/behind counts, and diff size.
- Add new fork customizations introduced by the merge or conflict resolution.
- Remove or mark retired customizations that upstream made redundant.
- Keep conflict notes tied to concrete files and behaviors, not vague history.

Finally, the subagent must report on

- new features or behaviors introduced by the upstream merge
- highlight those features or behaviors that can impact the customized behavior or functionality, or that should be otherwise specifically addressed
- analyse what from our customizations implementation could now be considered tech debt when compared to the changes that merge brought, and should be refactored for consistency with the new code

**Step 2**: If the subagent finishes its work but forgets to provide the above asked report, instruct the subagent asking again for it, with the details mentioned above. Skip this step if the subagent already provided a detailed report.

**Step 3**: If there is anything worth updating or refactoring, instruct the subagent to implement those refactors and changes.

**Step 4**: Instruct the subagent to update any stale or missing information in @CUSTOMIZED.md and related md files.

**Step 5**: Instruct the subagent to use the $assess-work skill.

When all tasks are finished, report back on everything the subagent has reported.
