# Threads from older T3 Code versions

On your first V2 launch, T3 Code copies the V1 database, `state.sqlite`, into `statev2.sqlite`
in the same data directory and migrates the copy. Your threads appear automatically, with full
transcripts imported as needed. You do not need to run an import command.

V1 continues using its original database while V2 uses the copy. The database import can run while
V1 is open. Opening V2 again resumes your V2 history. The copy happens only once: later conversations
and changes in either version do not sync to the other. Settings, attachments, and workspace files
remain shared.

The V2 desktop app uses a separate browser profile, so browser cookies and caches do not carry
over from V1. You may need to sign in again to websites opened inside the app.

The migrated thread keeps its title, project, provider and model selection, permission and
interaction modes, branch or worktree, archive state, settlement state, snooze and pin state, and
linked pull request. T3 Code also brings over user and assistant messages, their timestamps, and
supported attachments. Large histories may appear in stages while the server imports transcripts.

The migration does not recreate the old provider's live session. It also does not convert old run
records, checkpoints and diffs, tool activity, approval history, or proposed plan history into the
new format. These items may be absent from a migrated timeline even though the conversation text is
present.

## Continuing a migrated thread

The first new message starts a fresh provider session. T3 Code selects intact user and assistant
messages using the same [handoff budget](./portable-handoffs.md) as a provider switch. Omitted text
remains in the thread and can be retrieved by the agent. The migration retains its separate
32,000-character recovery excerpt; neither that excerpt nor the handoff replaces the full imported
transcript.

Before continuing a long or important thread, read the recent transcript and include any older
requirements the agent still needs in your next message. Starting a new thread and pasting a short
handoff is also a good choice when the old conversation contains conflicting instructions.

## Recovering work after returning to V1

If you used V2, returned to Stable, and created more work, recover that later V1 history with:

```sh
t3 threads recover-v1 --dry-run
t3 threads recover-v1 --output /path/to/recovered-statev2.sqlite
```

The command reads both databases and creates a separate recovered V2 database. It never overwrites
an input or an existing output file. Missing threads are imported, and additional messages are
added to existing threads when their conversation has not diverged. If both versions continued
a conversation, or V2 changed or deleted it, the V1 conversation is recovered as a separate thread
labelled “recovered from Stable”. Existing V2 thread settings are preserved.

Run this on the machine hosting the environment. Use `--base-dir <T3-home>` for a non-default
home, or `--source <v1-database>` and `--target <v2-database>` for recovery copies. Sources must
have reached V1 schema 54. Without `--output`, the command only reports its plan. Repeating recovery
against the recovered database skips unchanged work.
Later Stable messages extend an existing recovered copy if that copy has not diverged. Messages
added to an existing thread appear after its current timeline, even when their timestamps are earlier.

Before using the output, stop the V2 host, retain its current database as a backup, and put the
recovered file in its place as `userdata/statev2.sqlite`. Do not replace a running database. If
V2 has received more work since recovery, regenerate the output from the latest V2 database first.
V1 work created after the snapshot requires another recovery. Keep the original T3 home and
attachment files: this is a database recovery, not a portable export. The transcript limitations
above still apply; reasoning entries remain in the original V1 database.

## Keeping a recovery copy

T3 Code does not currently have a whole-thread export command. Before a major server update, stop
the server and copy its `userdata` directory to a safe location. The default is
`~/.t3/userdata`; a server started with `--home-dir <path>` uses `<path>/userdata`.

If a migrated transcript is missing from the app, keep that copy unchanged. You can inspect the
old transcript without starting a server against it:

```sh
sqlite3 -readonly /path/to/recovery-copy/state.sqlite
```

At the SQLite prompt, list recent legacy threads:

```sql
.headers on
.mode tabs
SELECT thread_id, title, updated_at
FROM projection_threads
ORDER BY updated_at DESC;
```

Then print one transcript, replacing `<thread-id>` with the value from the first query:

```sql
SELECT role, text, created_at
FROM projection_thread_messages
WHERE thread_id = '<thread-id>'
  AND role IN ('user', 'assistant')
ORDER BY created_at, message_id;
```

Open only the copied database. Do not edit it or point a newer or older server at your recovery
copy. If the affected environment is remote, make and inspect the copy on the machine that runs
that environment.
