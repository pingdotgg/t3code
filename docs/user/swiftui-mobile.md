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
settings can be entered here when the provider offers a credential form. Other settings must be configured on the computer.

Open **Software updates** in an environment’s connection details to check its T3 Code version.
Updates stay on that computer’s release channel. The app asks before restarting it. Provider
updates are available in **Settings > Providers** when the server supports them.

The composer uses the skills and slash commands for the selected project or worktree. Skills that
require direct user invocation insert a slash command. Agent-only skills do not appear in the slash
menu.

After changing skills, plugins, or tool permissions, choose **Restart agent session** in the
thread menu. This stops current work but keeps the conversation. The next message starts a
fresh provider process and resumes that conversation.

## New tasks and thread preferences

Choose **Add project > New** and enter a name to create a repository on the selected computer.
T3 Code creates the folder and first commit, then opens a draft in that project. When GitHub
is available, you can also choose to publish a private repository. A publishing error keeps
the local project.

To start without a repository, open the new-task project picker and choose **Scratch** on a
connected computer. This option requires a current server. Scratch tasks use a local workspace.

Use **Auto-settle** in a thread's menu to keep that thread active until you settle it yourself.
The choice is saved on its computer and applies to every client.

Environment and project preferences include submodule initialization and automatic storage
cleanup. Cleanup preferences apply only to the selected computer or project. A project can
inherit its computer's rules, use custom rules, or disable worktree cleanup.

## Icons and usage

Project icons set on the computer appear in the inbox. Environment icons follow each computer's
settings. Supported environments offer an icon picker in their connection preferences.

Usage loads each computer separately. A slow or offline computer does not prevent the others
from reporting. Use **Refresh prices** to fetch new model rates without waiting for the daily refresh.

Open **Usage > Limits** for subscription limits and reset times reported by your computers.
Supported Codex accounts also let you use a reset credit after confirmation. This uses a credit
on that account and cannot be undone. Computers that do not support limits can still report usage.

Older computers that report daily totals cannot supply the 24-hour view. Select 7d or 30d to
include their data.

## Thread connection state

Cached messages stay readable while a thread catches up. A status above the composer shows when
the content is incomplete or the computer cannot be reached. Use **Retry** if an update fails.
Working indicators return after the thread is current. File previews can finish loading after
the text is ready. Saved drafts load without waiting for the thread to catch up.

## Attachments and sharing

Current servers accept up to 100 photos, videos, or files per message. Each image can be up to
10 MiB, with at most 80 MiB of images in one message. Other files can be up to 50 MiB, or the lower limit reported by the connected server. Older servers accept
images only.

Attachments start uploading while you compose. **Preparing** means the attachment is waiting to
start. Failed or timed-out uploads show **Retry** and keep the local copy. If the app cannot save
the draft, it shows that error instead of reporting an upload in progress. Tap an image, PDF,
video, or other file to preview it with native controls when iOS supports that format.

Links to images, videos, PDFs and HTML files can also open files outside the workspace when the
server supports them. Failed previews show an error and a retry action.

You can share text, links, photos, videos, and files from another app into T3 Code. Choose a project
to add the shared content to a new-task draft. The share extension never sends the draft.

## Voice input

On supported devices with iOS 26 or later, the composer can transcribe up to five minutes of audio
on the device. Voice input needs microphone permission. The first use can also require Apple's
speech model download.

Tap Stop to finish recording. T3 Code inserts editable text into the draft and never
sends it automatically.

The screen stays awake while recording. Starting voice input keeps an open keyboard in place. Editing pauses until voice input finishes
or is canceled.

## Codex content

Codex file citations open the cited file when available. Artifact templates include a
**Use** action. **Use** inserts an editable prompt into the composer. Review or change it before
you send it.
