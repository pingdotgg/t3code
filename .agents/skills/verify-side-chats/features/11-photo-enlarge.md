# Photo enlarge

A photo in a side-chat reply opens in an enlarged viewer without distortion, and a composer thumbnail follows the same preview path.

## Sub-features

- `photo-viewer` enlarges a side-chat photo while preserving aspect ratio.
- `photo-thumbnail` enlarges an attached composer thumbnail and returns to the draft.
- `photo-markdown` enlarges a markdown image typed into the learner's own message.

## How to get to it (user POV)

- Send a photo in a side chat and choose its **Preview <filename>** control.
- Attach an image with **Attach images**, then choose its **Preview <filename>** thumbnail.
- Send `![photo](<absolute path to an image>)` in a side chat and click the image.

## Driving it with the Browser panel

Preconditions: an open side chat; fixture `~/side-chat-e2e/verify/fixtures/photo-480x300.png` (any 480×300 PNG).

- **Composer thumbnail.** `preview_upload` with `locator` `[aria-label="Side chat"] input[type=file]` and the fixture path, then `preview_click` `role=button[name='Preview photo-480x300.png']`. In a 1280×800 tab the dialog's `img` measures about 1024×640 (filled, ratio 1.6 kept); before PR #39 it was 480×300. `preview_press` `Escape`.
- **Sent photo.** Send the message, then `preview_click` `[aria-label="Side chat"] >> role=button[name='Preview photo-480x300.png']`. Same 1024×640.
- **Markdown image.** Type `![photo](/home/quokka/side-chat-e2e/verify/fixtures/photo-480x300.png)` into `[aria-label="Side chat"] [aria-label="Side chat message"]`, press `Enter`, then `preview_click` `[aria-label="Side chat"] [data-message-role="user"] >> nth=-1 >> role=button[name='Preview photo']`. Same 1024×640; before APP-20 it was 480×300. The same image in a lesson message stays 480×300.

## Gotchas

- Measure with `preview_evaluate` `document.querySelector('[role=dialog] img').getBoundingClientRect()`. A screenshot alone can't show the fill.
