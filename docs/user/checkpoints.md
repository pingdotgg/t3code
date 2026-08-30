# Checkpoint inspection

T3 records durable workspace checkpoints around agent turns. An agent with
access to the thread-scoped T3 Code tools can inspect those checkpoints without
changing files.

`t3_checkpoint_list` shows recent checkpoints for the current thread. It can
also inspect another thread in the same project. Each result identifies where
the checkpoint came from, summarizes a bounded number of changed files, and
reports whether the saved filesystem state is still available. Results are
paginated so a long-running thread does not load every checkpoint at once.

`t3_checkpoint_diff` reads a bounded patch between two checkpoints selected
from that list. Large patches include a cursor for the next page. The tool only
accepts durable checkpoint identities: it cannot read an arbitrary Git ref,
path, or another project's thread.

Inspection is read-only. A checkpoint that is stale, missing, or unavailable
is reported honestly rather than substituted with a different snapshot.
