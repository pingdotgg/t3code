# Terminals and long-running work

T3 Code asks Codex and Claude to use named tmux sessions for servers, watchers, long builds, and other commands that are intentionally left running. Normal one-off commands continue to use the provider's regular command execution.

Use **Attach tmux session** in the terminal controls to list sessions in the connected environment. Selecting a session opens it in the existing T3 Code terminal, including when the environment is remote.

When an environment has running tmux sessions, a small status tab appears above the composer. Click it to open the terminal drawer. T3 attaches every discovered session and lists them in the drawer's right-hand session rail. The rail stays visible when there is only one tmux session.

Closing the T3 Code terminal detaches from tmux without stopping the session or its processes. On web and desktop, terminate a session by opening the tmux menu in the terminal drawer, choosing **Stop session**, and confirming. This stops every process inside that tmux session.

Provider-native background tasks are not automatically converted to tmux sessions and cannot be attached through this menu.
