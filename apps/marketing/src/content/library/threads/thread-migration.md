---
title: "Bring threads from older T3 Code versions"
description: "Find T3 Code conversations after a V1-to-V2 upgrade, understand which history carries over, and keep a recovery copy before a major update."
updated: 2026-11-04
sources:
  - label: "Threads from older versions"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-migration.md"
  - label: "Portable handoff behavior"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/portable-handoffs.md"
  - label: "Legacy and current handoff code"
    url: "https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration-v2/ContextHandoffService.ts"
faq:
  - question: "Do I need an import command for old T3 Code threads?"
    answer: "On the first V2 launch, T3 Code copies the V1 state.sqlite database into statev2.sqlite and migrates the copy. Your threads appear automatically, with full transcripts imported as needed."
  - question: "Do V1 and V2 T3 Code conversations stay synchronized?"
    answer: "T3 Code copies the database once. Later conversations and history changes do not sync between V1 and V2, although settings, attachments, and workspace files remain shared."
  - question: "Why are old checkpoints missing from my migrated thread?"
    answer: "T3 Code migration imports conversation text and thread metadata but does not convert old checkpoints, diffs, run records, tool activity, approval history, or proposed plan history into V2 records."
  - question: "Does T3 Code have a whole-thread export command?"
    answer: "T3 Code does not currently have a whole-thread export command. Before a major server update, stop the server and copy its userdata directory to a safe location."
---

T3 Code imports V1 threads automatically on the first V2 launch by migrating a copy of the old database. Conversation text and thread metadata carry over, but the migration does not recreate the old provider's live session or convert every historical activity record.

## Understand the one-time database copy

V1 uses `state.sqlite`. On the first V2 launch, T3 Code copies it into `statev2.sqlite` in the same data directory and migrates that copy. You do not need to run an import command, and the database import can run while V1 is open.

After that first copy, the versions have separate conversation histories. V1 continues using its original database. Reopening V2 resumes V2 history rather than copying V1 again. New messages and history changes in one version do not sync to the other.

Settings, attachments, and workspace files remain shared. Separate conversation databases therefore do not mean you have separate copies of the code or uploaded files. Keep that distinction in mind if you continue work in both versions.

For the surrounding upgrade process, read [updating T3 Code](/learn/start/updating). If you need an installer, use the [official download page](/download).

## Check what the migrated thread preserves

The imported thread keeps its title and project, provider and model selection, permission and interaction modes, and branch or worktree. Archive, settlement, snooze, and pin states also carry over, along with the linked pull request.

User and assistant messages retain their timestamps. Supported attachments also come across. Large histories can appear in stages while the server imports their transcripts. A partial initial view does not establish that the full transcript is gone.

| Preserved material                        | Material not converted into V2 records |
| ----------------------------------------- | -------------------------------------- |
| User and assistant messages               | Old run records and tool activity      |
| Thread metadata and workspace association | Old checkpoints and diffs              |
| Supported attachments                     | Approval and proposed plan history     |
| Saved thread organization                 | The old provider's live session        |

A visible message about a past change is not a restored checkpoint for that change. Use [working with threads](/learn/threads/working-with-threads) to understand current checkpoint and restore behavior before expecting an old turn to support file restoration.

## Continue a migrated conversation

1. Read the recent imported transcript.
2. Identify older requirements that still apply.
3. Put those requirements and the next task in your new message.
4. Send the message to start a fresh provider session.

T3 Code selects intact historical messages using the same budgeted approach as a provider switch. Omitted history remains in the thread and can be retrieved by the agent. Read [portable handoffs](/learn/threads/portable-handoffs) for what that selection includes and excludes.

Migration also retains a separate 32,000-character recovery excerpt. That excerpt is not the portable handoff's universal size limit. Neither the excerpt nor the selected continuation context replaces the full imported transcript.

If the old conversation contains contradictory instructions, a new thread with a short, current handoff can be a better choice. State the decisions that remain valid and what the next agent should do. This is a workflow choice, not a requirement to discard an imported conversation.

## Restore the desktop experience separately

The V2 desktop app uses a separate browser profile. Website cookies and caches from V1 do not carry over, so you may need to sign in again to websites opened inside the app.

On its first launch, V2 copies stashed prompts, unsent drafts, layout, and theme from V1. Changes you make in V2 afterwards stay in V2. A missing website login and a missing conversation are therefore different problems with different recovery paths.

Before troubleshooting history, check which version and environment you opened. This helps distinguish the one-time database copy from an ordinary website sign-in or client layout change.

## Keep a recovery copy before a major update

T3 Code does not currently provide a whole-thread export command. Before a major server update, stop the server and copy its `userdata` directory to a safe location. The default is `~/.t3/userdata`; with `--base-dir <path>`, use `<path>/userdata`.

If a transcript is missing, preserve that copy unchanged. Inspect only the copied database in read-only mode. Do not edit it or start a newer or older server against the recovery copy.

```sh
sqlite3 -readonly /path/to/recovery-copy/state.sqlite
```

At the SQLite prompt, list the legacy threads:

```sql
.headers on
.mode tabs
SELECT thread_id, title, updated_at
FROM projection_threads
ORDER BY updated_at DESC;
```

Then replace `<thread-id>` with the chosen value to read its messages:

```sql
SELECT role, text, created_at
FROM projection_thread_messages
WHERE thread_id = '<thread-id>'
  AND role IN ('user', 'assistant')
ORDER BY created_at, message_id;
```

These queries inspect the legacy conversation text. They do not rebuild missing V2 activity or resume the former live provider session. For a remote environment, make and inspect the copy on the machine running that environment.

## Next steps

- Use [portable handoffs](/learn/threads/portable-handoffs) to prepare a clear continuation, then organize it with [working with threads](/learn/threads/working-with-threads).
- Start [issue triage](/learn/threads/triage) if migration still looks wrong, or return to [threads and messages](/learn/threads).
