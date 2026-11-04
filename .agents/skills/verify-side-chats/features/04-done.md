# Done

Done finishes an active side chat and leaves an outcome note; discard removes it, while asking in a finished chat reopens it.

## Sub-features

- `done-finish` finishes a chat and writes its note.
- `done-discard` discards an empty or unwanted chat.
- `done-reopen` reopens a finished chat by asking again (driven at the end of feature 5).

## How to get to it (user POV)

- Choose **Done** in the side-chat header.
- Choose **More side chat actions** → **Discard**.
- In a finished chat, select a reply and choose **Ask in side chat**.

## Driving it with the Browser panel

Preconditions: a side chat opened in this run, with a sent message and a finished reply. Before clicking Done, check with `preview_evaluate` that its panel shows no status line (`Goes with…`, `Sent to…`, `No note needed`, `Couldn't write the note`). A chat finished in an earlier run passes without Done ever reaching the server.

- **Finish.** `preview_click` `[aria-label="Side chat"] >> role=button[name='Done'] >> nth=0`. The tab closes; the panel moves to another chat or closes.
- **Server proof.** `preview_navigate` to the lesson URL, `preview_click` `role=button[name='Side-chat map']`, then `preview_click` the chat's `role=treeitem[name=/^<label>/]` (choose a phrase no earlier chat used, so the label is unique). `preview_wait_for` `[aria-label="Side chat"] >> text=/Goes with your next lesson message|No note needed|Couldn't write the note/` (30 s). This status line only shows for a chat the server marked done, so it fails when Done is ignored.
- **Discard.** In a disposable chat, `preview_click` `role=button[name='More side chat actions']`, then `role=menuitem[name='Discard']`. Its treeitem disappears from the map.

## Gotchas

- Done closes the tab while the note is written in the background. Judge only after the reopen and the status line, never from the click.
- An empty, never-written chat may be deleted on close. Use a chat with a message to prove Done.
