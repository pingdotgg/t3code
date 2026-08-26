# CopilotKit review demo

This demo adds a CopilotKit-powered PR review agent to Git-backed local and bearer-authenticated server threads. It can:

- inspect the current branch range and dirty working tree through T3 Code's existing review API;
- render a review dashboard with navigable findings;
- open referenced files in T3 Code;
- ask for explicit approval before making changes;
- hand the exact approved findings to the normal T3 Code coding agent.

## Run locally

Set an OpenRouter API key in the shell that launches T3 Code:

```sh
export OPENROUTER_API_KEY=...
```

The review agent sends requests to OpenRouter and defaults to `openai/gpt-5-mini`. Override it
with another OpenRouter model slug when needed:

```sh
export COPILOTKIT_REVIEW_MODEL=google/gemini-2.5-flash
```

Start the normal development environment, open a server thread backed by a Git repository, then use the CopilotKit button in the lower-right corner. A good first prompt is `Review this branch`.

The CopilotKit runtime route requires the same authenticated orchestration operate scope as other mutating T3 Code routes. The coding handoff consumes a one-time approval for the exact findings shown to the user.
