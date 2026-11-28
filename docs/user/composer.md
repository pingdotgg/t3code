# Messages and context

Use the composer to send prompts, attach files, reference threads or pull requests, invoke skills, and steer or queue follow-ups.

## Limits and large pastes

- **Message length**: Up to 120,000 characters.
- **Large pastes**: Pasting 32 KiB+ of text (or any paste that would exceed the message limit) turns it into a text-file attachment so it doesn't bloat the prompt. Use `Cmd+Shift+V` (Apple) or `Ctrl+Shift+V` (Windows/Linux) to paste inline instead.

## Formatting

The composer renders Markdown live as you type and reveals raw markers when your cursor enters styled text. The agent receives the exact Markdown you typed.

- Disable live styling in **Settings → Chat → Rich text composer**.
- Standard Markdown triggers (`- `, `1. `, `- [ ] `, `> `, `# `, `---`, and ` ``` ` + Enter) create lists, quotes, headings, rules, and code blocks.
- In lists/quotes, `Shift+Enter` continues (or exits on an empty line), and `Tab` / `Shift+Tab` indents or outdents.
- In code blocks, `Enter` keeps indentation, `Tab` / `Shift+Tab` indents selected lines, and closing ` ``` ` + Enter (or two blank lines) exits the block.

## Attach files

Attach up to **100 files** per message:

- **Images**: Up to 10 MiB each, 80 MiB total per message. HEIC/HEIF photos are converted to JPEG, and oversized photos are resized automatically.
- **Other files (including videos)**: Up to 50 MiB each (subject to environment limits). Video attachments pass a file path; only [Antigravity](./providers-antigravity.md#skills-and-attachments) sends supported videos natively to Gemini models.

Files upload to the environment's machine as soon as you attach them, and all uploads must finish before sending. Provider and model limits still apply.

- **Web and desktop**: Drag, paste, or pick files. Reloading before an upload finishes requires re-attaching.
- **Mobile**: Pick files, share into T3 Code via the system share sheet, or drag images in Android split screen.

In the desktop app, when the thread's environment runs on this computer, drag a
folder onto the composer or choose **Folder…** from the attach button to add its
path. Nothing is uploaded, so there is no size limit; the agent reads the folder
in place.

See [images and videos](#images-and-videos-in-messages) for previewing and saving media.

## Send while the agent is working

Choose your default follow-up behavior in **Settings → Chat → Follow-up behavior** (per client):

- **Queue**: Holds the message on the server for the next turn.
- **Steer**: Injects the message into the running turn (when supported by the agent).

Shortcuts while a turn is running:

- **Opposite action**: `Cmd+Enter` (macOS) or `Ctrl+Enter` (Windows/Linux) uses the non-default action. If your send shortcut already requires `Cmd/Ctrl+Enter`, add `Shift`. On mobile, long-press the send button or use `Cmd/Ctrl+Return` on a hardware keyboard.
- **Steer oldest queued message**: `Cmd+Shift+Enter` (macOS) or `Ctrl+Shift+Enter` (Windows/Linux) sends the first queued message as a steer without touching your current draft. Remap `thread.steerQueuedMessage` in **Settings → Keybindings**, or add a rule in your [keybindings file](./keybindings.md#edit-the-configuration-file) to trigger it on `mod+enter` when the composer is empty:

```json
{
  "key": "mod+enter",
  "command": "thread.steerQueuedMessage",
  "when": "composerFocus && turnRunning && composerEmpty"
}
```

- **Edit most recently queued message**: `Option+Up` (macOS) or `Alt+Up` (Windows/Linux) at the start of the composer (`thread.editQueuedMessage`).

Slash commands (such as `/compact` or `/context`) wait for the current turn to finish rather than steering into it. [Goal](#goals) commands are the exception.

## Queue messages offline on mobile

Mobile keeps local copies of draft attachments so you can preview them and queue messages offline. Uploads resume on reconnect, and drafts/queued messages survive app restarts and T3 Connect sign-out (restored when signing back into the same account).

## Custom models and defaults

- **Remembered defaults**: T3 Code remembers your last provider, model, and options for new threads. A project's configured model overrides this. Leaving reasoning level or service tier unset uses the provider's default.
- **Custom models**: Add unlisted models in **Settings → Providers → Models** (web and desktop; not supported for Antigravity, which uses its account catalog).
- **Rename a built-in model across all clients**: Add an entry in the server's `userdata/settings.json`:

```json
{
  "providerInstances": {
    "codex": {
      "driver": "codex",
      "config": { "customModels": [{ "slug": "gpt-5.5", "name": "Team GPT" }] }
    }
  }
}
```

## Model defaults

T3 Code remembers your provider, model, and model options for new threads. A
project's configured model takes precedence; resetting that project setting
returns to the remembered selection.

Leaving reasoning level or service tier unset uses the provider's own configuration.

## Group conversations

Invite models from different providers into one thread to discuss a task together.
Enable **Group conversations** in **Settings → Labs → Zack** for the environment,
then choose **Invite a model** in an existing thread and pick a model. You can also
use `/invite`, or **Invite a model** in the command palette.

Messages reach everyone by default. The thread's own model answers first, and the
others then add only what that answer lacks, or stay quiet. If nobody answers,
remaining members get a turn one at a time within the same turn limit. Type `@` and choose
group members to address them directly; those you name all answer at once. Each
message can start at most eight model turns, including follow-up replies. In a larger group, address up to eight members at a time.
Members can answer each other, and they share the workspace and can
edit its files under the thread's existing permissions. Open a member's **Work**
view to see its tools, answer its questions, or approve its requests.

**Stop** pauses the discussion and stops all members. A member's own Stop control
stops only that model. Rewind waits until the discussion stops. If a member has
unanswered replies, send another message to continue.

Choose **End group** to continue with the thread's own model and the shared
conversation as context. Turning off the setting prevents new invitations;
existing groups still let you remove members or end the group.

## Project memory

Open **Project memory** from the thread details, the command palette, or
`mod+shift+u` on web or desktop, or from thread actions on mobile. Search
conversations and saved facts in the current project, inspect their sources, and
select evidence for your next message. Selecting a fact shows its evidence;
choose **Attach** to include the selected evidence in your draft. Archived conversations are excluded unless
you include them. A fact whose cited message was edited, deleted, or archived is
flagged in the list.

Thread agents can read and change memory only within their own project and
environment. Threads in that project share its memory; another project's facts
do not appear in their recall, searches, or memory tools.

To search the current project's facts, conversations, and code symbols at once,
choose **Search facts, conversations, and symbols** in the command palette or
press `mod+alt+f`. Each kind of result is listed separately; if one is
unavailable on the server, the others still appear.

To save a fact from the conversation, choose **Remember for this project** on a
message. Project memory opens that message; choose **Save as
fact** to start a fact prefilled from it and citing it.

Agents can save observations for later recall. They are saved immediately, with
no approval step. You can edit or forget a fact, and its origin shows who recorded
the current assertion. Forgetting removes the fact's content everywhere T3 kept it,
including its earlier revisions and the copy recorded as sent with past messages.

When knowledge changes, **Supersede** the old fact instead of forgetting it. The
replacement is linked to the old fact, which keeps its content but no longer comes
up in recall unless you show superseded facts. After you save, T3 points out
existing facts that look like duplicates or possible contradictions so you can
compare them before making a replacement.

When **Save facts from finished runs** is on, T3 reviews new runs from a thread
and its child threads together. A batch is eligible after eight completed runs or
30 minutes of inactivity. Your text generation model can propose up to three
facts in one call per eligible batch. Each fact needs a citation to a message
you wrote or corroborating messages from separate runs in different threads.
Failed and stopped runs can supply evidence. Change this setting under **Memory
health** in Project memory or in **Settings → Labs → Zack**. Project memory
shows the last outcome and the **Automatic** filter lists automatically saved facts.

A second call reads the proposed facts without the conversation and asks whether
a new agent on unrelated work would need each one.
A fact that only applies to one task, or that describes how code behaves, is
discarded automatically. Only standing project knowledge is saved; there is no
review queue or approval step. If the check fails, T3 saves nothing and
tries the batch again later. Some providers, such as Grok, cannot run the check; with one of
those as your text generation model, T3 skips each batch without calling the model.

An exact repeat can add new citations to a saved fact. Trust, age and retrieval
history affect recall. Forgetting a fact removes its content, and a later run
can supply new evidence for it.

**Curate project memories** is on by default in **Settings → Labs → Zack** and
can be overridden per project. Your text generation model periodically reviews
small batches of that project's agent-written memories. It automatically removes
task notes and code descriptions, and removes outdated or duplicate facts when
an existing replacement is supported by evidence. A fact's age alone is not a
reason to retire it. Facts you wrote or explicitly restored are protected from
automatic review.

Removal takes effect immediately, without asking for confirmation. It erases the
fact's content, earlier revisions, and stored copies sent to agents. The original
source conversations stay intact. **Memory health** shows the last review's
outcome. Removed memories cannot be restored; the **Forgotten** list retains only
an empty record of their removal. Memories previously set aside automatically are
removed by background maintenance too.

You don't need to pick facts by hand. When you send a message, T3 sends up to two
saved facts related to it along with your message, as **Recalled project memory**.
Recall skips messages where you attached project knowledge yourself, and messages
sent when the context window is nearly full. Agents can also search project
memory at any point in a turn.

A thread receives each fact once. T3 also never recalls a fact the thread's agent
has already found by searching or reading memory, or a fact that was saved from
that thread. T3 sends recalled facts in a short form without their citations. It
cuts a long fact short, and the agent reads the rest when it needs it.

T3 asks the agent to rate recalled facts it can judge. A helpful vote raises a
fact's trust, and a misleading fact gets a downvote that lowers trust. Marking a
fact unrelated to the task leaves its trust unchanged. T3 recalls only facts
with enough trust. During review, the curator sees each fact's trust and votes
since its last edit. It checks the fact and its sources before removing it.

Open a fact's details to see its revisions, ratings and trust changes. To remove
it permanently, choose **Forget**. **Memory health** counts facts by status.
When facts lose their cited
source, the **Lost source** filter lists them; on mobile, select the lost-source
count in the memory summary.

Preview and attach your selection before sending. The attachment keeps references
to the selected evidence. T3 checks those references again when the agent's turn
starts. If a fact or source changed, was forgotten, or became unavailable, select
the evidence again. Removing the attachment leaves the saved facts intact.

## Quote an assistant response

- **Web and desktop**: Select text in an assistant message and click **Cite in composer**. Click the pencil on the chip to add or edit a comment; click the chip to jump back to the source.
- **Mobile**: Long-press an assistant response, select text, and tap **Cite**. Tap a quote chip to edit its comment, remove it, or jump to the source message.

Quoted text and comments count toward the message length limit and are preserved across copy/paste and [stashed prompts](#prompt-stash).

## Recall a sent prompt

Press `ArrowUp` in an empty composer to cycle backward through earlier prompts in the thread, and `ArrowDown` to move forward. Only prompt text is restored (not attachments or context chips). Editing a recalled prompt turns it into a normal draft.

## Suggested next prompt

Enable **Settings → Labs → Suggest next prompt** (web and desktop) to show a predicted next message in the empty composer after a Claude or Codex turn completes.

- Press `Tab` to accept or `Escape` to dismiss.
- Each suggestion uses one cached request against your plan's usage. Claude skips suggestions on the first turn and near usage limits.
- Codex requires CLI version 0.165+ (update in **Settings → Providers**). Open Claude threads pick up the setting after restarting.

## Edit an earlier prompt

On web and desktop, select **Edit from here** under a sent message to rewind the conversation to before that message and return it to the composer:

- **Revert and keep changes**: Rewinds the conversation only.
- **Revert files too**: Restores workspace files to the checkpoint before that message (including your own edits). Only available for worktree threads when no other thread or active session shares that directory.

Rewinding removes later messages from the active thread and provider history (requires provider rewind support), but cannot undo external actions or separate provider memory.

## Prompt stash

On web and desktop, press `Cmd+S` (macOS) or `Ctrl+S` (Windows/Linux) to stash the current draft and its attachments (wait for uploads to finish first). Press the same shortcut in an empty composer to restore the stash (or open the stash menu if you have multiple).

- Holds up to 100 prompts in browser storage; stashes are never auto-deleted.
- Stashes with uploaded files must be restored in their original environment. Uploads expire after 24 hours; use **Attach again** or remove expired files before sending.

## Voice input

Dictate into the composer with the microphone button or `mod+shift+d` (web and desktop). Audio stays on-device or goes only to an environment/provider you explicitly choose in **Settings → Voice**. See [Voice input](./voice-input.md) for setup, mobile dictation, and microphone priority.

## Queued messages

Queued messages appear at the end of the thread (web/desktop) or above the composer (mobile). From a queued message you can:

- **Send now**: Injects it immediately into a running turn (or moves a slash command to the front of the queue).
- **Edit**: Opens the message and its attachments in the composer without losing your existing draft.
- **Remove**: Cancels the queued message.

If you stop the agent or the server restarts, queued messages pause in order. Click **Resume** in an empty composer (or send a new message) to continue. When the provider supports native continuation, **Resume** continues without sending a new prompt.

## Commands and skills

Type `/` for commands or `$` for skills from the selected environment and provider.

The slash menu also includes skills unless you turn off **Settings → Chat →
Show skills in slash menu**, under Advanced. Only skills enabled for the provider are listed.
Built-in [pstack](./pstack.md) skills, unless turned off, are listed for every
provider.

After you add or change skills, plugins, or MCP servers, use **Restart agent
session** in the command palette on web and desktop. The conversation continues,
and your next message starts the agent again with the new setup.

### One skills library for every provider

Inference routing uses skills from the machine running the thread, not from the inference
host. OpenCode and Pi keep their usual skill paths. Claude and Codex also pick up personal
skills from their local profiles; a skill installed directly in the routed profile wins if
both have the same name. Turning off **Use your Claude profile** keeps those personal skills private.

Turn on **Settings → Labs → Zack → Skills library** to keep one set of
skills for every provider and account on that environment. T3 Code moves each skill
folder from `~/.claude/skills`, `~/.codex/skills`, and Antigravity's user skill folders
into `~/.agents/skills` and links it back, and links every skill there into Claude's
and Antigravity's skill folders. Codex,
Cursor, OpenCode, and other agents that read `~/.agents/skills` see the same set. Claude's
account-synced skills and Codex's bundled skills stay where they are. Configured Claude and
Codex homes participate too. Claude accounts with **Use your Claude profile** turned off keep
their private skills.

A skill found in two places with identical contents is kept once. When the contents
differ, nothing is moved for that skill and the setting lists both paths; delete or
rename one copy, then select **Refresh**. The same holds for two skills whose names differ
only in case, and for a skill folder that links to a file outside itself, since moving it
would break the link. A skill you add to `~/.agents/skills` by hand
reaches Claude at the next refresh, server start, or new account.

At the next refresh, T3 restores library links in configured homes that are no longer shared.
Homes still used by another account or the default profile stay shared. Turning the library off copies each linked skill back into
Claude's and Antigravity's folders and removes the links, including previously used homes. Codex keeps reading `~/.agents/skills` directly. Each environment has
its own library, so turn it on for every machine you want it on.

Provider commands must start the message to run. T3 Code commands such as
`/model` and skill mentions work on any line.

Type `@` followed by part of a model or provider name, such as `@opus` or `@gpt`,
to insert a reference naming that model for the agent. This is useful for
delegation, for example “delegate this to …”. It does not change the thread's
model. Mentions can't contain spaces, so join words with `:`, `/` or `-`, for
example `@gpt:traex`.

Send `/compact` in an existing conversation to reduce context usage when the
provider supports it.

Send `/clear` on its own, or pick it from the slash menu, to start a fresh session
in the same thread. Your next message goes to a new provider session that doesn't see the
earlier messages, and the thread marks where it began with **New session**.
Earlier messages and diffs stay in the thread. Dismiss the notice above the
composer to keep the current session instead.

On web and desktop, turn on **Context window** in **Settings → Appearance →
Thread details** to see context usage in the thread details card. It appears
once the provider reports usage.

Claude instances can also compact idle threads for you. See
[compact long conversations](./providers-claude.md#compact-long-conversations).

## Goals

With Codex, Claude, and OpenCode 2.2.5+, send `/goal <criteria>` (for example, `/goal all tests in packages/api pass`) so the agent keeps working across turns until the goal is met.

- `/goal` alone shows the current goal. `/goal clear` removes it.
- Codex and OpenCode also support `/goal pause` and `/goal resume`. Stopping
  their goal pauses it. Codex also pauses when its work ends without meeting the goal.
  **Resume** on the goal line restarts a paused or blocked goal. While the agent
  works, it waits for the current turn to end.
- Stopping Claude ends the current turn, but the goal stays set. Claude checks it
  again at the end of your next message.
- Sending a new goal, or `/goal resume`, while the agent works stops the current
  turn and starts the goal, unless you queue it. `/goal clear` and `/goal pause`
  stop the turn only when it is working on the goal. Other goal commands wait for
  the turn to end.

## Context in your message

Attached context—files, terminal excerpts, diff/file review comments, preview annotations, pull requests, and threads—appears as inline chips at your cursor. Click a chip to inspect or open its source; copy/paste and [Prompt stash](#prompt-stash) preserve chips across drafts.

- **Pull requests (`#`)**: On web and desktop, type `#` to browse recent PRs in the current repository (linked PRs appear first), type digits to match by number, or type a word to search by text.
- **Threads (`@`)**: Type `@` and part of a thread title to reference a thread on the same server (or on a linked machine when Linked environments is enabled). You can also drag threads from the sidebar onto the composer, or paste a copied thread link. The prompt carries only a reference—the agent reads the thread on demand. Dropping a thread from an unlinked environment attaches a snapshot transcript file instead.
- **Models (`@`)**: Type `@` and part of a model or provider name (e.g. `@opus` or `@opus:opencode`) to reference a model in your prompt (such as for delegation) without changing the thread's model.
- **Images vs. files**: Images keep a thumbnail shelf above the composer plus optional inline chips; files live only as inline chips (deleting the last chip removes the file).

## Attached files

Select any file chip in a draft or sent message to preview it (syntax-highlighted code/JSON, rendered/raw Markdown/HTML/CSV/TSV, audio playback, and ZIP folder browsing up to 50 MB). Large text files show a truncated preview—save the file to read it in full.

When a preview asks for a file password, enter it and select **Unlock**. T3 Code uses the password on your device. Web and desktop can unlock supported PDF, ZIP, Office, and OpenDocument files. The mobile app can unlock ZIP attachments, and Android can unlock PDFs. Ebooks protected by DRM need a compatible reader.

## Images and videos in messages

Select an image or video attachment or link to preview it.

- **Web and desktop**: Right-click media to save it or copy its path/URL.
- **Mobile**: Long-press a thumbnail and choose **Save or share**.

File links point to the file on the environment's machine, so moving or deleting the original breaks the preview—save a copy if you need to keep it.

## Files outside the workspace

Following an agent's file link to a file outside the workspace opens it read-only. External HTML files cannot load neighboring scripts, styles, or images.

## HTML and PDF files in the file viewer

On web and desktop, HTML and PDF files open rendered (HTML previews are sandboxed from your T3 Code session; line-specific HTML links open source view). On mobile, PDFs open in the native iOS viewer or an installed Android viewer.
