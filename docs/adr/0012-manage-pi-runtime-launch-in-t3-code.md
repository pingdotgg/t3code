# Manage Pi runtime launch in T3 Code

Each Pi runtime instance will expose a binary path, optional Pi configuration directory, optional additional launch arguments, generic instance environment, display name, and accent color. T3 Code retains exclusive control of Pi's RPC mode, session directory, and thread session ID; settings validation rejects additional arguments that would override those managed launch parameters.
