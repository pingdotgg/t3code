# Triage an issue

Let your own coding agent investigate a Hyakki problem—reading local logs/state, inspecting the source for your installed version, checking known issues, and helping draft a GitHub issue. The agent always asks before applying fixes or posting anything.

## In the app

Open the command palette (`Cmd/Ctrl+K`) and run **Triage an issue**. A no-project thread opens on the active machine with the triage playbook attached—pick any provider, describe the problem, and send.

## In a terminal

If the app won't start or in-app triage fails, run:

```sh
hyakki triage
# Or choose a specific CLI agent and model:
hyakki triage --agent codex --model <model-id>
hyakki triage --agent antigravity
```

Supports Claude Code, Codex, and standalone Antigravity (`agy` on `PATH` with its own sign-in; Hyakki's managed ACP runtime does not include the standalone terminal CLI).
