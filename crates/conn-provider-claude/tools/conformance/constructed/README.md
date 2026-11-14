# Constructed transcripts

Stub transcripts made from a recording plus frames copied from the T3 server's own Claude
fixtures, for a CLI state no recording here has. `run.sh` takes a script from
`testdata/cli` first, then from here.

- `e16_background_task.ndjson`: `e01_turn` with a background Bash task left running when the
  turn ends: `background_tasks_changed` and `task_started` (`local_bash`,
  `is_backgrounded: true`) before the result, shaped as in T3's
  `claude_background_task_after_root` fixture. The CLI then stays open with background work,
  as a real one does.
