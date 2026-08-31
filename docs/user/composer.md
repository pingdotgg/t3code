# Message composer

Messages can contain up to 120,000 characters. If a draft is longer, T3 Code keeps it in the
composer and shows how many characters need to be removed. Shorten the draft or split it into
multiple messages, then send again in the same thread.

On mobile, an empty composer shows an interrupt button while the agent is working. Adding text
or an attachment replaces it with the send button. This applies to both compact and expanded
composers.

You can attach images up to 10 MB. On servers that support file uploads, you can also
attach videos, text files, PDFs, ZIP archives, and other files. Each file can be up to the limit advertised
by the server, capped at 50 MB. Each message can contain up to eight attachments in total. Files
upload directly to the environment, where your agent can read, copy, or edit them by their file path.

On web and desktop, attachments upload as soon as you add them. The send button becomes available
after every upload finishes. Failed uploads can be retried or removed. On mobile, tap **+** to open
the photo library from either the compact or expanded composer. When the connected server supports
file uploads, **+** opens a menu beside the button with **Photo Library** and **Choose Files**.
Videos use the server's file upload limit. You can also share photos, videos, and files into
T3 Code from other apps through the system share sheet. Mobile uploads happen when the message
sends, so queued messages keep their files until they deliver. Select a received file on mobile
to preview it or open the system share options.

Tap an image or PDF before or after sending to open it. On iOS, images zoom from their thumbnail
into the native viewer. Pinch or double-tap to zoom, and swipe down or tap Close to return.
Use Share to save a copy or send it to another app. PDFs support page navigation and search.
PDF links in assistant responses open the same preview. On Android, images open in the image
viewer and PDFs open the system chooser.

Select a video attachment before or after sending to play it. Web and desktop use the browser's
built-in controls. On mobile, videos open in a full-screen player with native playback controls.
Supported videos show a thumbnail in the conversation and composer.
On iOS, received videos stream from their environment as they play. Supported formats and codecs
depend on the browser or device; you can save an unsupported video to open it in another app.

On iOS, the system player zooms from the attachment. Swipe down or tap Close to return to the
conversation or draft. Touch and hold the attachment, then choose **Save or share video** to open
the system share options. On Android, use **Save or share video** inside the preview.

On web and desktop, if you reload before a file finishes uploading, the draft keeps the file's name
and shows **Attach again** next to it. Attach the file again or remove it, then send.

On web and desktop, HEIC and HEIF photos are automatically converted to JPEG when you drag them into
the composer or paste them into a message. On iOS, selecting them from **Photo Library** also
converts them to JPEG. The 10 MB image limit applies to the converted photo.

On mobile, the model picker shows each OpenCode model's upstream provider, such as Anthropic,
GitHub Copilot, or OpenCode Zen, beneath its name. Search by that provider name to narrow the list
when starting a thread or changing an existing thread's model.

## Notices above the composer

On web and desktop, loading and syncing statuses fill the available banner width beside the
stash tab. Task progress appears above the composer, while the timeline's working timer shows
only elapsed time.

On web and desktop, additional notices peek out above the attached banner. Hover over the peek
to reveal them, or focus **Show other notices** with `Tab` and press `Enter` or `Space`. Press
`Escape` to close the stack and return focus to that control. On a touchscreen, tap the peek to
open the stack. Interacting with the attached banner or composer does not open the stack.

## Prompt stash

Use the default shortcut, `Cmd+S` on macOS or `Ctrl+S` on Windows and Linux, to stash the current
prompt and its attachments after all file uploads finish. Restore the entry later from the stash
menu. Stashes that contain files must be restored in the environment where those files were
uploaded. Stashed files stay uploaded on the server for 24 hours. If you restore an entry after
that, the file comes back with **Attach again** next to it. Attach the file again or remove it, then
send.

## Voice input on iPhone

On supported iPhones with iOS 26 or later, tap the microphone in the composer to record a message.
An expanded composer keeps your draft visible and flips its bottom toolbar into recording controls
with waves that respond to your voice. A collapsed composer flips into a compact recording strip
without changing height. Tap the checkmark to finish and transcribe on your device. The waves fade
into a transcription status, then the usual
controls return with the text inserted at the selection where recording started. If the keyboard
is open when you start, it stays open during voice input. You can review and edit the text before
you send it.

The first use can download Apple's speech model and needs a network connection. Later transcription
works offline for that language. A recording can be up to five minutes long. Canceling voice input,
leaving the screen, or an audio interruption discards the new recording and keeps the existing draft
and attachments. T3 Code deletes the local audio file after transcription or cancellation. It sends
only the normal message text when you submit the draft.

## Commands and skills

Type `/` to open the command menu. Type `$` to find and add a skill. Skill rows show their source,
such as System, Personal, Project, or App.

On mobile, these menus are available on the **New task** screen before you start a thread. They
use the skills and commands from the selected environment and provider.

By default, the `/` menu includes skills. To keep this menu command-only, turn off **Show skills in
slash menu** in **Settings → General**. Skill results use the `/skill:Skill Name` label and add the
same `$name` skill token to your message. The original skill name remains searchable. If the provider
also reports that skill as a native slash command, T3 Code hides the duplicate native entry and keeps
the `/skill:Skill Name` label.

On desktop, press `Cmd+Enter` on macOS or `Ctrl+Enter` on Windows and Linux from a new thread to
start it in the background. T3 Code opens another new thread and shows an **Open** action for the
thread that started. The new thread keeps the selected workspace mode and base branch. If **New
worktree** is selected, each background thread creates its own worktree.
