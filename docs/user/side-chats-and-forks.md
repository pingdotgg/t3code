# Side chats and forks

Side chats and forks both branch an existing conversation with its context intact. They differ in
where the new conversation appears:

- **Open side chat** opens the branch beside the current thread on web and desktop. On mobile, it
  opens as a full-screen conversation. Side chats stay out of the main thread sidebar.
- **Fork to new thread** creates a normal thread and opens it as the main conversation.

Use the fork action on a completed agent response to choose the exact point where the new
conversation begins. You can also open a side chat or fork the latest completed turn from the
thread menu or command palette. **Open side chat** defaults to `mod+shift+b`. **Fork thread** has
no default shortcut, but you can assign one in **Settings → Keybindings**.

## Provider support

Forking follows the active provider's session capabilities:

- **Codex** can fork from any completed agent response.
- **Claude** and **OpenCode** can fork only from the latest completed agent response.
- **Cursor**, **Grok**, and **Antigravity** do not currently support session forking.

When a provider does not support forking, or the thread has no completed turn, the thread-menu and
command-palette actions remain visible but unavailable. Earlier response actions are omitted for
providers that can fork only from the latest turn.

## Managing side chats

Closing a side-chat tab only closes that local panel. The conversation still exists and can be
reopened from **Side chats** in its parent thread's menu. On mobile, the same menu opens each side
chat as a full-screen thread.

Choose **Promote to thread** to move a side chat into the main thread list. Its conversation and
link back to the parent are preserved.

Deleting a side chat uses the normal thread delete action and permanently clears its conversation
history. Closing and deleting are separate actions.

Forked threads and promoted side chats show **Forked from _parent title_** at the top of the
conversation. Select it to return to the source thread. If the source thread was deleted, the label
stays but no longer opens anything.
