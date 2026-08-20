# Importing existing chats

T3 Code can import local chat history from Codex, OpenCode, and Hermes.

Open **Settings → Providers**, find the platform's chat history section, and select
**Import all chats**. Re-running an import is safe: sessions that are already linked to a T3 Code
thread are skipped.

Imports preserve the conversation text and supported work-log details, including tool calls,
commands, command output, failures, and file artifact paths. Codex imports include active and
archived sessions. OpenCode imports read the local OpenCode database. Hermes child-agent sessions
do not appear as separate chats. Re-running a Hermes import removes child-agent chats imported by
an older T3 Code version.

## Sidebar organization

Imported and native threads use the same hierarchy in the settled and active shelves:

```text
Platform
└── Project
    ├── Chat
    └── Chat
```

Threads with no usable working directory appear under **Chats not in a project**, which is kept at
the end of that platform's project list. Provider instances that use the same platform, such as two
Codex accounts, remain under one platform heading.

The project is determined from the session's recorded working directory. Importing history does not
modify the original Codex, OpenCode, or Hermes files.

## Default history locations

- Codex: `~/.codex/sessions` and `~/.codex/archived_sessions`
- OpenCode: `~/.local/share/opencode/opencode.db`
- Hermes: the configured Hermes home

The importer uses the provider's configured home when available, so non-default profiles can be
imported as well.
