# OMP

T3 Code connects directly to the Oh My Pi (`omp`) native RPC interface. Install OMP 18.16.0 or newer on the machine running your T3 server, configure its model provider there, then enable **OMP** in Settings. If `omp` is not on that server's PATH, set its binary path.

OMP keeps its configured models, authentication, project context, extensions, and skills. The model picker uses OMP's discovered models and thinking levels. Workspace slash commands and skills appear in the composer. Terminal-only widgets and editors that require a custom terminal renderer are not displayed.

Assistant text, reasoning, tool output, compaction, usage, and native subagent progress appear in the conversation. You can stop or steer a running turn and queue subsequent messages. A yielded model response remains active while OMP reports pending asynchronous work. OMP confirmation, selection, text-input, editor, and structured question dialogs appear in T3 Code; pending dialogs do not survive a process restart.

Supervised mode asks before commands and changes. Auto-accept edits allows the built-in edit and write tools; Full access runs without T3 confirmations. These controls use OMP's blocking extension hook. Native subagent approval forwarding is not supported; use the OMP terminal for workflows requiring separate child approval dialogs.

Native OMP sessions can be discovered and imported. Import creates a snapshot, not a live synchronization. Repeating an import preserves the existing T3 history. Resuming an imported session uses a private copy under T3's state directory, leaving the original transcript unchanged. Native conversation forks and rollback use OMP's session tree. Project paths must exist on the server that owns the provider.

Provider settings show version advisories and an update action when the installation supports it. Native installations use `omp update`; package-managed installations use their owning manager. Updates run separately from existing agent processes and refresh provider metadata afterward. Existing processes retain the version they started with; start a new session to use the updated binary. T3 does not automatically update OMP, change its release channel, or update plugins.

T3's MCP tools are available to the agent. Native OMP subagents appear in the work log, but separate child thread browsing, child stop/wait/fork controls, structured plan review and TODO panels are not available through this provider. Use OMP's own commands and tools for those workflows. Terminal UI themes, widgets, live voice, and terminal input shortcuts remain terminal features.
