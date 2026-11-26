# Workflow skills

This fork ships its own set of agent skills: planning, review, orchestration, and the principles they lean on. They target T3 Code and its MCP tools, and any provider T3 Code runs can use them: Claude, Codex, Grok, and OpenCode.

Every skill is a plain [Agent Skills](https://agentskills.io) folder: `<name>/SKILL.md` plus any files it references. Write them provider-neutral. Say "delegate to a subagent" or "ask the user", not the name of one provider's tool, and prefer T3 Code's MCP tools (`delegate_task`, `t3_thread_*`, `preview_*`) where one fits.

## Layout

Skills are grouped by where they came from, so each vendored set can be updated against its upstream:

| folder               | source                                                                        | license                         |
| -------------------- | ----------------------------------------------------------------------------- | ------------------------------- |
| `skills/ak/`         | ours                                                                          | this repo                       |
| `skills/anthropic/`  | Anthropic's `frontend-design` plugin                                          | Apache-2.0, `LICENSE.anthropic` |
| `skills/mattpocock/` | [mattpocock/skills](https://github.com/mattpocock/skills)                     | MIT, `LICENSE.mattpocock`       |
| `skills/pstack/`     | [cursor/plugins `pstack`](https://github.com/cursor/plugins/tree/main/pstack) | MIT, `LICENSE.pstack`           |
| `skills/tstack/`     | [t3dotgg/tstack](https://github.com/t3dotgg/tstack)                           | MIT, `LICENSE.tstack`           |

Each vendored folder has an `ATTRIBUTION.md` naming the upstream commit it was last synced to and every local change made since. Sync by hand: diff the upstream at the new commit against the recorded one, apply that diff to our copy file by file, then update `ATTRIBUTION.md`.

Inside `pstack/` and `mattpocock/`, skills sit one level down in a role folder: `factory/` for the steps the wayfinder and maestro pipeline runs on its own, `on-demand/` for skills a person calls for one situation, and `guidance/` (pstack only) for the principles and style rules that apply whenever their situation comes up. A role folder holds no `SKILL.md` of its own. Upstream keeps each skill at `<skill>/`, so a sync maps it to `<role>/<skill>/` here.

Skill folder names are unique across all groups, because providers see one flat list. `vp run workflow:link` refuses to run when two groups share a name.

## Installing

```sh
vp run workflow:link
```

It symlinks every skill into `~/.claude/skills`, `~/.agents/skills`, and `~/.codex/skills`, which between them cover every provider. The links point into the main checkout, so pulling the fork updates skill content in place. Rerun it after adding or removing a skill. The in-app source update and the `update-t3` skill run it for you.

`vp run workflow:map` rewrites `skills/ak/ak-help/skill-map.md`, the chart of which skill names which. Rerun it and commit the result when skills change.

To keep one folder out, for example a `~/.claude` that other tools on that machine share, put an empty `.no-workflow-skills` file in it.

The script only touches symlinks that point into `workflow/skills`. A real file or folder with the same name as one of our skills is left alone and reported as skipped.
