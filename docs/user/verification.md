# Verify changes

Open **Verify changes** in a started conversation's header. The panel is available in the web interface and the Windows desktop fork. Opening it reads existing evidence; it does not start an agent turn.

Choose **Tests and static checks**, **Browser checks**, or both, then select **Run verification**. Browser recording is off by default and requires browser checks. The request uses the conversation's current agent, model, permissions, and environment, so its normal token costs apply. It asks one agent to verify the changes and report issues without modifying the implementation.

The panel shows the latest requested verification in that conversation. Each recorded command has an outcome and, when the provider reports it, an exit code. A successful command needs both completion and exit code zero. Completion without a reported exit code is **Unconfirmed**. **Run completed** means the agent finished its turn, not that every user flow passed.

The agent report uses the same Markdown and media viewer as the conversation, including links to screenshots and recordings. The panel also offers the current diff and any available linked pull-request checks. Those PR checks describe the current PR, not necessarily the exact revision the agent verified. Existing reports remain in the conversation history and can be reopened without asking the model to regenerate them.

A busy conversation cannot start another verification from the panel. Stop a running agent through the conversation's existing stop control. If sending the request fails, the panel shows the error and allows retry. Read-only connections can review evidence but cannot start verification.

Browser tools and recording availability depend on the provider and environment. Missing evidence stays missing; the panel does not turn an agent's successful completion into a blanket test approval. Re-run verification after further edits before relying on earlier results.
