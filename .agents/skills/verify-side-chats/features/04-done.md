# Done

Done finishes an active side chat and leaves an outcome note; discard removes it, while asking in a finished chat reopens it.

## Sub-features

- `done-finish` finishes a chat and writes its note.
- `done-discard` discards an empty or unwanted chat.
- `done-reopen` reopens a finished chat by asking again.

## How to get to it (user POV)

- Choose **Done** in the side-chat header.
- Choose **More side chat actions** → **Discard**.
- In a finished chat, select a reply and choose **Ask in side chat**.

## Driving it with the Browser panel

Preconditions: the side chat has at least one user message; keep a disposable chat for discard.

- **Finish.** Call `preview_click` `{role:"button", name:"Done", exact:true}`. `preview_wait_for` the panel, then `preview_snapshot`; it shows the finished state and a status such as `Writing note…`, `Goes with your next lesson message: …`, `Sent to lesson: …`, or `No note needed`.
- **Server proof.** Reload the lesson with `preview_navigate` to its current URL and `preview_snapshot`. The finished state/status must persist; a transient click or toast is insufficient.
- **Discard.** Open **More side chat actions** with `preview_click` `{role:"button", name:"More side chat actions"}`, then `preview_click` `{role:"menuitem", name:"Discard"}`. Snapshot shows the panel closed and the discarded mark absent from the map.
- **Reopen.** Open the finished chat from its map row/mark, select a reply, and `preview_click` `{role:"button", name:"Ask in side chat"}`. Snapshot shows the same side-chat path with an open composer; this fails if Done was ignored.

## Gotchas

- Done closes the tab while its note is written in the background; wait for the status or reload before judging.
- An empty, never-written chat may be deleted on close; use a message-bearing chat to prove Done.
