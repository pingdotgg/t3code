# SwiftUI mobile

The native SwiftUI app connects to one or more T3 Code computers. Each server owns the settled
state of its threads. Change automatic settlement in an environment's connection details.
These user preferences also apply to other connected environments that support them. Offline
environments keep their existing settings. Open **Preferences** in connection details to see
differences and apply one environment's preferences to the others.

Use **Refresh models** in the model picker for a new or existing task to reload models for the
selected computer. Other connected computers are not refreshed.

## Providers and skills

Open **Settings > Providers**, or **Providers** in the model picker, to manage a provider on its
computer. Supported providers offer runtime installation and sign-in. Antigravity can be enabled
here. Runtime files and credentials stay on that computer. API keys and enterprise authentication
settings must be configured on the computer.

The composer uses the skills and slash commands for the selected project or worktree. Skills that
require direct user invocation insert a slash command. Agent-only skills do not appear in the slash
menu.

## Icons and usage

Project icons set on the computer appear in the inbox. Environment icons follow each computer's
settings. Supported environments offer an icon picker in their connection preferences.

Use **Refresh prices** in Usage to fetch new model rates without waiting for the daily refresh.
A failed environment does not remove the usage data from other environments.

## Thread connection state

Cached messages stay readable while a thread catches up. A status above the composer shows when
the content is incomplete or the computer cannot be reached. Use **Retry** if an update fails.
Working indicators return after the thread is current. File previews can finish loading after
the text is ready.

## Attachments and sharing

One message can contain up to eight photos, videos, or files. Images can be up to 10 MB. Other
files can be up to 50 MB, or the lower limit reported by the connected server. Older servers accept
images only.

Attachments start uploading while you compose. If an upload fails, the draft keeps its local copy
so you can retry or remove it. Tap an image, PDF, video, or other file to preview it with native
controls when iOS supports that format.

Links to images, videos, PDFs and HTML files can also open files outside the workspace when the
server supports them. Failed previews show an error and a retry action.

You can share text, links, photos, videos, and files from another app into T3 Code. Choose a project
to add the shared content to a new-task draft. The share extension never sends the draft.

## Voice input

On supported devices with iOS 26 or later, the composer can transcribe up to five minutes of audio
on the device. Voice input needs microphone permission. The first use can also require Apple's
speech model download.

Tap the checkmark to confirm the recording. T3 Code inserts editable text into the draft and never
sends it automatically.

## Codex content

Codex file citations open the cited file when available. Artifact templates include a
**Use** action. **Use** inserts an editable prompt into the composer. Review or change it before
you send it.
