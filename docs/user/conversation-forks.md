# Fork conversations with agents

Agents connected through T3 Code's built-in MCP server can create a durable conversation fork without changing Git branches or workspaces.

`t3_thread_fork` requires an explicit stable source point: the latest completed run, a specific completed run, or a checkpoint belonging to a completed run. Omitting `sourceThreadId` uses the current conversation. The new conversation stays in the same project and inherits the source conversation's provider selection and modes, limited by the calling agent's permission ceiling.

The result identifies the source and new conversation, the requested and canonical source points, and the durable fork transfer. It also says whether a native provider fork is currently eligible. The transfer remains pending until the new conversation's first turn, when T3 Code chooses native fork or portable context using the active provider's capabilities. A pending result does not mean provider context has already moved.

Use `t3_thread_transfers` to inspect fork and other context-transfer records on a conversation. Results are newest first and can be filtered by transfer type.

`clientRequestId` is required for forks. Reusing it returns the original thread and command receipt instead of creating another fork.
