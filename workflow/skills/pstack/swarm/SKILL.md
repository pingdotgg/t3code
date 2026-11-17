---
name: swarm
description: "Fan out N parallel workers, drain them, and return one report. Use for /swarm, 'swarm this', or parallel coverage, races, gauntlets, and exploration."
---

# Swarm

## Start

Open a todolist with one entry per phase before launching anything.

1. Frame
2. Fan out
3. Aggregate
4. Report

## Phase A: Frame

1. State the done predicate and the artifact or report the swarm must return.
2. Choose the shape. Partition into slices, race N workers on identical briefs, or mix both. For a race or mixed shape, declare `first pass`, `rank all`, or `best-of` before spawning. If workers must ship code, don't swarm them: file tickets with `to-tickets` and run `implement-spec` (this session) or `maestro` (parallel). If the race arms are competing attempts at one artifact and you want the best one improved with the others' best parts, use `arena`, not a race.
3. Set N from the user or derive it from the shape. N is total workers.
4. Pick the worker model. Default to a mid-tier model, a fast, cheap one for mechanical slices, and your strongest for slices needing judgment. For a race, name each arm's model up front.
5. Cap N. Twelve workers is the ceiling unless the user asks for more, and anything above that gets stated in the report along with what it costs. A swarm that silently spawns fifty agents is a bill, not a strategy.
6. Give each worker its own writable output when it writes. Use a worktree, branch, or `/tmp/swarm-<slug>/worker-<n>/`. When workers verify or measure commits, each brief names the exact SHAs. A measurement brief also names the method (sample count, what one sample is, order). The worker records both in its result.

## Phase B: Fan out

Delegate to all N workers at once (in T3 Code: `delegate_task`) on the chosen model. Give each worker its own output, per `~/.agents/skills/principle-separate-before-serializing-shared-state/SKILL.md`. Brief a worker as read-only when its slice is, which is the common case for coverage and exploration shapes.

When a worker must start from a non-default branch, give it a worktree on that branch (in T3 Code: `isolation: "worktree"`).

Every brief stands alone. Include the goal, scope, exact slice or race arm, how to verify, and what to report. Reports use `PASS`, `ISSUES`, or `BLOCKED` with evidence. A worker that can prove a defect reports `ISSUES` and lists every issue it can prove, not only the first.

If a worker drops out, proceed with N-1 and note it.

## Phase C: Aggregate

Read the terminal results. Drop a result that does not record the SHAs and method its brief names, and respawn that worker once. After a second miss, record a gap. A gap does not count as a pass. For coverage, every required slice needs a result. For a race, apply the selection rule declared up front. Use first pass, rank all, or best-of. Do not paste raw worker dumps.

## Phase D: Report

Return one consolidated in-chat report with a result table, issue one-liners, gaps or dropouts, and the race rule when used.
