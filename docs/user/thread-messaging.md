# Messaging between threads

Agents in active threads from the same project can coordinate through two built-in tools:

- `thread_list` returns active sibling threads with their stable T3 thread ID, title, status, branch,
  and workspace kind.
- `thread_send` delivers a message to one of those thread IDs and starts or queues a turn there.

T3 records the message and turn request before it starts, resumes, or steers the recipient's provider
session. The recipient sees a server-authored source thread title and ID, so message text cannot forge
the sender's identity.

Thread messages do not share provider conversation context or expose another thread's transcript.
They also do not wait for the recipient, merge worktrees, or create new threads. Include the context
the recipient needs in the message, and use the source thread ID in the attribution if a reply is
useful.

Delivery is limited to active sibling threads in the same project. A thread cannot message itself.
`thread_send` returning `accepted` means T3 durably accepted the target turn; it does not mean the
recipient finished the work.
