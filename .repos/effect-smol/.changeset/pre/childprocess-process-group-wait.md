---
"@effect/platform-node-shared": patch
"effect": patch
---

Wait for Node child process groups to exit during scoped release and `kill`.

After signalling a process group, both operations now wait for its leader and descendants. Without `forceKillAfter`, the wait is limited to one second and never escalates. With `forceKillAfter`, the group receives `SIGKILL` at the deadline, followed by a final wait of up to one second. Native timers keep escalation working under a `TestClock`, and cleanup no longer depends on stdio closing.

`exitCode` and `isRunning` remain tied to the leader's exit, and a leader that already exited successfully still leaves its group untouched. Process group checks count zombies, so cleanup may wait for the full bound under a non-reaping PID 1.
