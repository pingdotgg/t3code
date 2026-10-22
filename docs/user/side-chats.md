# Side chats

A side chat lets you ask something about a thread without interrupting it. It opens in the right
panel next to the thread, stays out of the sidebar, and keeps working while the main thread runs.

## Start one

- **Thread details → Side chats → +** starts one. The arrow beside it chooses the kind.
- **Ask** on selected text quotes the selection into a new side chat.
- The fork button on a response has **Ask about this response**, which shares the thread up to that
  response.
- Type `/side` in the composer. `/btw <question>` sends the question immediately; a bare `/side`
  reopens your latest side chat, or starts one.
- The command palette entry and the **Side Chat: Open or Start** shortcut, which you can set in
  keybinding settings, do the same as a bare `/side`.

## Talking to a side chat

Starting or reopening a side chat hands it the thread's composer. A **Side chat** banner above the
composer says so, and every message you send goes to the side chat, without typing `/btw` again.
Press Escape, or the banner's close button, to talk to the main thread again. Your draft for the
main thread is still there. **Reply in side chat** at the bottom of the side chat switches back.

If the main thread asks for an approval or an answer while you're in a side chat, a banner says
so. Escape takes you to it.

## With or without history

**With history** forks the thread at its last finished run, so a run still in progress is not part
of it. The panel header says how far it sees, for example "Sees up to run 4". **Without history**
starts empty and only links back to the thread. The **+** remembers your last choice.

With history is unavailable until the thread has a finished run, and for providers that cannot
share their history with a new thread yet. The menu says which.

## Editing

A side chat shares the main thread's files, so it asks before changing anything. Turn on **Allow
edits** in its header to let it change files without asking each time; commands still ask.

## Finishing

Use the menu in the side chat's header:

- **Bring back to main** merges the answer into the main thread with your next message. It never
  interrupts the current run, and needs a side chat that started with history.
- **Promote to thread** turns it into an ordinary thread in the sidebar.
- **Discard** deletes it.

Closing a side chat's tab keeps it under **Side chats** in the thread details, under **Previous**
once it stops running. Closing one that never got a message discards it.

Side chats are on web and desktop. The mobile app leaves them out of its thread list; promote one
to see it there.
