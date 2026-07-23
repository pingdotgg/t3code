# Isolate Pi sessions by provider instance

Each T3 Code Pi provider instance will use its own Pi `--session-dir`, and each T3 Code thread will use its thread ID as Pi's session ID. T3 Code starts Pi in persistent-session mode immediately; Pi materializes the native session file lazily while persisting the first accepted prompt's turn. Threads therefore retain deterministic, resumable native-session identity while providers with different credentials or configurations cannot share session storage accidentally.
