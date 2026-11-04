# Photo enlarge

A photo in a side-chat reply opens in an enlarged viewer without distortion, and a composer thumbnail follows the same preview path.

## Sub-features

- `photo-viewer` enlarges a side-chat photo while preserving aspect ratio.
- `photo-thumbnail` enlarges an attached composer thumbnail and returns to the draft.

## How to get to it (user POV)

- Ask for or receive an image in a side-chat reply and choose its **Preview <alt>** control.
- Attach an image with **Attach images**, then choose its **Preview <filename>** thumbnail.

## Driving it with the Browser panel

Preconditions: a side chat with a rendered image and a disposable local image for the composer.

- **Reply photo.** `preview_click` `{role:"button", name:"Preview <alt>"}`. `preview_snapshot` shows dialog title `Expanded <alt> preview`, an image with the original aspect ratio, and a close button; record screenshot and ARIA snapshot.
- **Return.** `preview_press` `Escape`; snapshot shows the side-chat reply and no expanded dialog.
- **Composer thumbnail.** `preview_click` `{role:"button", name:"Attach images"}`, use `preview_evaluate` to set the file chooser only if the panel exposes it, then `preview_snapshot` and click `{role:"button", name:"Preview <filename>"}`. The same `Expanded <filename> preview` dialog opens; `preview_press` `Escape` returns to the draft.

## Gotchas

- The exact Preview name comes from the image alt text or filename; obtain it from the ARIA snapshot instead of guessing.
- If no image provider/scenario or file chooser is available, record the unmet precondition and do not claim photo enlargement.
