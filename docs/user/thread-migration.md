# Threads from older T3 Code versions

On your first V2 launch, T3 Code automatically copies your V1 database (`state.sqlite`) to `statev2.sqlite` in the same data directory and migrates it. V1 and V2 stay independent afterward (changes in one do not sync to the other), while settings, attachments, and workspace files remain shared.

## What migrates

- **Included**: Thread metadata (title, project, provider/model, modes, branch/worktree, archive/settle/snooze/pin state, linked PR), user/assistant messages, timestamps, and supported attachments. On desktop, first launch also copies V1 stashed prompts, drafts, layout, and theme (browser cookies/caches do not carry over).
- **Not included**: Live provider sessions, old run records, checkpoints/diffs, tool activity, approvals, and proposed plan history.

## Continuing a migrated thread

Sending your first message starts a fresh provider session using the [portable handoff budget](./portable-handoffs.md). Omitted text remains saved in the thread and readable by the agent, though for long or critical threads it's worth restating key constraints—or starting a fresh thread with a short summary.

## Keeping a recovery copy

T3 Code does not have a whole-thread export command. Before a major server update, stop the server and back up your `userdata` directory (`~/.t3/userdata` by default, or `<base-dir>/userdata`).

If a migrated transcript is missing, inspect your backup read-only without pointing a server at it:

```sh
sqlite3 -readonly /path/to/recovery-copy/state.sqlite
```

```sql
-- List legacy threads
.headers on
.mode tabs
SELECT thread_id, title, updated_at
FROM projection_threads
ORDER BY updated_at DESC;

-- Print one transcript
SELECT role, text, created_at
FROM projection_thread_messages
WHERE thread_id = '<thread-id>'
  AND role IN ('user', 'assistant')
ORDER BY created_at, message_id;
```
