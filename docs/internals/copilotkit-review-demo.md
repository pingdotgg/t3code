# CopilotKit review demo

This demo adds a CopilotKit-powered PR review agent to Git-backed local and bearer-authenticated server threads. It can:

- inspect the current branch range and dirty working tree through T3 Code's existing review API;
- wait for an explicit **Start review** click before reading or sending any diff;
- render the branch map, diff reads, and review passes as live CopilotKit GenUI;
- render navigable findings from the final `submit_review` tool call;
- open referenced files in T3 Code;
- run without a CopilotKit chat surface.

## Run locally

Open **Settings → CopilotKit**, paste an OpenRouter API key, and press Enter. The key is saved in
T3 Code's server secret store; it is not written to `settings.json` or returned to clients.

Choose the review model from the same page. Model changes are saved immediately and both settings
apply to the next review without restarting T3 Code.

For backwards compatibility, `OPENROUTER_API_KEY` is still used when no saved key exists, and
`OPENROUTER_BASE_URL` can still override the OpenRouter endpoint. Other provider errors are shown
in the pane.

Start the normal development environment and open a server thread backed by a Git repository. Open
the right panel and choose **CopilotKit Review**. The pane stays idle until you choose **Start
review**. After a completed review, choose **Redo review** to run it again against the latest diff.

The pane deliberately shows which parts come from CopilotKit. `useAgent` owns the review agent,
`useAgentContext` supplies the active project and branch, and four `useFrontendTool` calls expose the
review workflow. Each tool includes a custom renderer. The headless pane uses `useRenderToolCall` to
turn the agent's live tool-call messages into the visible branch map, progress cards, and final
review. T3 Code keeps control of the surrounding right-panel layout, file navigation, and result
validation; there is no CopilotKit chat surface.

The CopilotKit runtime route requires the same authenticated orchestration operate scope as other
mutating T3 Code routes.
