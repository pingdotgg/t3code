# Integrate Pi through its CLI RPC mode

T3 Code will treat Pi as a first-class `pi` provider driver that starts the user-installed Pi CLI in `--mode rpc` and adapts its JSONL protocol. This follows the existing Codex app-server integration pattern while preserving the user's installed Pi version, credentials, settings, extensions, and native session behavior.
