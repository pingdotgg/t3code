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

Attachments upload as soon as you add them while connected to a server that supports uploads.
The send button becomes available after every upload finishes. Failed uploads can be retried or
removed. On mobile, tap **+** to open
the photo library from either the compact or expanded composer. When the connected server supports
file uploads, **+** opens a menu beside the button with **Photo Library** and **Choose Files**.
Videos use the server's file upload limit. You can also share photos, videos, and files into
T3 Code from other apps through the system share sheet. Mobile keeps a local copy of each draft
attachment, so you can still preview it and queue messages while offline. Uploads resume when
you reconnect. Drafts and queued messages survive app restarts; signing out of T3 Connect keeps
them on your device until you sign back into the same account. Select a received file on mobile
to preview it or open the system share options.

Tap an image or PDF before or after sending to open it. On iOS, images zoom from their thumbnail
into the native viewer. Pinch or double-tap to zoom, and swipe down or tap Close to return.
Use Share to save a copy or send it to another app. PDFs support page navigation and search.
PDF links in assistant responses open the same preview. On Android, images open in the image
viewer and PDFs open the system chooser.

Select a video attachment before or after sending to play it. Web and desktop use the browser's
built-in controls. On mobile, videos open in a full-screen player with native playback controls.
Supported videos show a thumbnail in the conversation and composer.
On web, desktop, and iOS, received videos stream from their environment as they play. Supported formats and codecs
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

## Model defaults

T3 Code remembers the last provider, model, and model options you selected and reuses that
selection for new threads. A model configured in a project's settings overrides the remembered
selection for that project; resetting the project setting returns it to the remembered selection.

Model options shown as provider defaults remain display values until you choose them in T3 Code.
T3 Code only sends options you selected explicitly, so an unset reasoning level or service tier can
still come from the provider's own configuration.

## Quote an assistant response

On web and desktop, select text in an assistant response, then choose **Cite in composer** from the
menu that appears when you release the selection. This inserts an inline quote chip at your cursor
and opens an optional comment bubble beside the selected text; press `Enter` or choose **Save** to
attach the comment, or leave it blank to keep just the quote. You can type before and after the
chip, such as a quote followed by "what do you mean?". A selection must stay within one response
and fit in 8,000 characters.

The chip shows your comment when it has one, or a short quote preview otherwise. Use the pencil
button to add or change the comment, and the remove button to delete the quote and its comment from
the draft. Copying, reloading, and restoring a [stashed prompt](#prompt-stash) keep each comment
with its quote, and sending tells the agent which words were quoted and which comment you wrote.
The quoted text and comment count toward the message limit.

Select a chip in the composer or a sent message to open the source thread, scroll to the response,
and highlight the quoted passage — including in older history. The
highlight pulses, holds for a moment, then fades on its own; press `Escape` to stop the navigation
or clear it early. If the source is unavailable or its text has changed, the saved quote stays
readable and T3 Code shows a warning.

Mobile shows the full saved quote and its comment in sent messages. It does not offer
**Cite in composer** or navigation to a quote's source.

## Images and videos in messages

On web, desktop, and mobile, select a link to an image or video to open it inside T3 Code.
Workspace image and video links open the file viewer. Links to media outside the workspace
open a media preview.
Videos opened from the file explorer or a file-viewer tab also play inside T3 Code. They
stream from the environment as needed, rather than downloading the entire video before playback.
Paths in inline code, such as `/tmp/recording.mp4`, work the same way. Image embeds stay inline;
video embeds show a player with controls and an option to expand. Visible video previews load
an initial frame when supported, but stay paused until you press Play. Video file references use
a filmstrip icon.

On web and desktop, hover over a preview to see its full file path or original URL. Right-click
to copy that reference, save an image, or copy an image to the clipboard. Use the video player's
built-in controls to download videos. If the player cannot decode a video, its error message
offers a link to open the source in the browser. Workspace media also offers **Copy relative
path** and **Open in file viewer**. These actions are available in expanded previews too.

On mobile, touch and hold an inline image or use a preview's **Media actions** menu to see its
source, copy the path or URL, or choose **Save or share**. Workspace media can open in the file
viewer from the same menu. Saving downloads a copy only when you request it; it does not change
how the video buffers during playback.

Use Markdown image syntax to embed either kind of media:

```markdown
![Screenshot](/tmp/screenshot.png)
![Recording](/tmp/recording.mp4)
[Open recording](/tmp/recording.mp4)
```

Relative paths resolve from the thread's workspace. Absolute paths and `file://` links refer to
the environment's machine, even when you connect remotely or use your phone. Supported media
can live outside the workspace, including in Downloads or `/tmp`.

T3 Code serves the original file without adding it to attachment storage. If that file is moved
or deleted, its preview can no longer load from the environment. A browser or device may still
have a cached copy. Supported video formats and codecs depend on the browser or device.

Bare paths in ordinary prose and paths inside code blocks stay text. Raw HTML `<video>` tags
are not supported; use the Markdown embed syntax above.

## Files outside the workspace

When an agent links to a file it wrote outside the workspace, such as a Markdown report in
`/tmp`, select the link to open it in the file viewer. The viewer shows the file read-only, with
rendered Markdown available as usual; it cannot edit files outside the workspace. HTML and PDF
files outside the workspace open the same way as ones inside it. Because such a file is served on
its own, an HTML page outside the workspace cannot load scripts, styles, or images from files beside
it.

## HTML and PDF files in the file viewer

On web and desktop, the file viewer shows HTML and PDF files as a rendered page. Use the
source toggle in the viewer's header to switch an HTML file between the page and its markup; the
choice persists like the rendered-Markdown toggle. A link to a line always opens the source. HTML
runs in an isolated frame with no access to your T3 Code session. On desktop, the integrated
browser remains available from the same header for a full browser view.

## Changing projects

On web and desktop, changing the project from a new thread keeps the current environment when that
project exists there. If it does not, T3 Code selects another environment that has the project.

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

A skill token runs the skill wherever it sits in your message. T3 Code sends it to each provider in
the form that provider runs, so the text before and after the token is kept. Skills that only you may
start, and never the agent on its own, work the same way. A skill you switched off in the provider's
settings does not appear in either menu.

Provider commands such as `/compact` only run when they open the message, so the `/` menu offers
them only there. T3 Code's own commands, such as `/model` and `/plan`, and skills stay available on
any line.

On desktop, press `Cmd+Enter` on macOS or `Ctrl+Enter` on Windows and Linux from a new thread to
start it in the background. T3 Code opens another new thread and shows an **Open** action for the
thread that started. The new thread keeps the selected workspace mode and base branch. If **New
worktree** is selected, each background thread creates its own worktree.
