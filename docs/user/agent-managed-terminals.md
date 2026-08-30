# Agent-managed terminals

Agents connected through T3 Code's built-in MCP server can inspect and control terminals owned by conversations in the same project. A target conversation is optional and defaults to the agent's current conversation. Terminal-targeting operations use an explicit terminal ID; `t3_terminal_list` discovers those IDs without requiring one.

`t3_terminal_list` lists only terminal sessions currently retained by the server. `t3_terminal_read` returns a bounded tail of one retained output buffer, including character offsets, truncation, and the terminal event sequence. These reads never open or attach to a shell, restart an exited terminal, or load persisted history. A session that was evicted, closed, or has not been loaded is reported as unavailable even if an older history file exists.

`t3_terminal_open` starts a shell in the conversation's current execution directory. That may be a nested directory inside a worktree; the physical worktree path remains separate. Opening an existing running terminal returns it unchanged. Opening an existing exited or failed terminal does not restart it.

Terminal mutations are host execution. They are available only when both the calling conversation and target conversation use full-access runtime mode and default interaction mode. Plan, approval-required, auto-accept-edits, and auto runtime contexts can still list and read retained terminal state, but cannot open, write, resize, clear, restart, or close terminals through MCP.

`t3_terminal_write` reports only that the running PTY accepted the bytes. It does not report whether a shell command later succeeded. Writes and restarts are non-idempotent. Use `t3_terminal_read` to observe output and status. `t3_terminal_close` always requires one terminal ID and never closes every conversation terminal by omission.
