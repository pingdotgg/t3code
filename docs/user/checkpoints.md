# Checkpoint inspection

T3 records durable workspace checkpoints around agent turns. An agent with
access to the thread-scoped T3 Code tools can inspect those checkpoints without
changing files.

`t3_checkpoint_list` shows recent checkpoints for the current thread. It can
also inspect another thread in the same project. Each result identifies where
the checkpoint came from, summarizes a bounded number of changed files, and
reports whether the saved filesystem state is still available. Results bound
the returned checkpoints and only perform filesystem-ref checks for that page;
the server still reads the thread's durable V2 projection to select them.

`t3_checkpoint_diff` reads a bounded patch between two checkpoints selected
from that list. Large patches include a UTF-16 code-unit cursor for the next
page. A page can exceed its requested limit by one code unit rather than split
a surrogate pair. The tool only
accepts durable checkpoint identities: it cannot read an arbitrary Git ref,
path, or another project's thread.

Inspection is read-only. A checkpoint that is stale, missing, or unavailable
is reported honestly rather than substituted with a different snapshot.

## Restore safety

`t3_checkpoint_restore` restores one exact checkpoint selected from the list.
It is destructive: current tracked and untracked changes covered by the
restore are discarded, so the agent must explicitly acknowledge that outcome.
The thread must be idle with no queued work, and the provider must support
rolling its conversation back to the same point.

T3 verifies that the workspace has not changed between the request and the
locked restore. If files or thread state change concurrently, the restore
fails and preserves the newer state. The result distinguishes a request that
is still running, a fully applied restore, a failure, and a partial result
where files were restored but the provider conversation could not be rolled
back. Retrying with the same idempotency key reads the original result instead
of starting another restore.
