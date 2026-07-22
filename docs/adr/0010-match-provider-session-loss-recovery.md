# Match existing provider session-loss recovery

When a Pi RPC process or connection ends, T3 Code will not replay an in-flight turn because that could duplicate tool calls. It will mark the active turn interrupted and close the live session, matching existing Codex and Claude provider behavior; when the user later continues, T3 Code starts Pi against the persisted native session using the same runtime-instance configuration.
