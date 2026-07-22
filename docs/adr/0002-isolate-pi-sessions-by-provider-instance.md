# Isolate Pi sessions by provider instance

Each T3 Code Pi provider instance will use its own Pi `--session-dir`, and each T3 Code thread will use its thread ID as Pi's session ID. Threads therefore remain native, resumable Pi sessions while providers with different credentials or configurations cannot share session storage accidentally.
