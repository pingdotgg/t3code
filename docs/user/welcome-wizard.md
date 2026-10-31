# Import conversations

Choose **Import conversations** on the empty home screen or in Settings > Providers.
You can also open `/welcome`. Choose the connected environment that holds your
terminal sessions, then import a project's conversations. Existing projects are reused.

Claude Code, Codex and Pi conversations active within the last 30 days can be
imported and continued in T3 Code. Pi is off by default: enable it in provider
settings, then refresh the import page. Pi uses each enabled provider's session
directory, following `PI_CODING_AGENT_SESSION_DIR` and `PI_CODING_AGENT_DIR` in its
environment. The imported conversation follows the active branch that Pi reopens.

Import is best effort. Skipped conversations are reported without discarding
successful imports. Each attempt reads a bounded batch; import the same project
again to continue. Conversations already imported are not duplicated.
