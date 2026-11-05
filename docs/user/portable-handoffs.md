# Context in portable handoffs

T3 Code transfers conversation context when you switch providers, continue through a portable
restart, or use a fork that the provider cannot resume itself.

Short conversations transfer intact. For longer conversations, T3 Code favors recent requests and
answers, the original request, and relevant activity such as command outcomes. Selected messages
keep their full text, order, and user or assistant role, including partial work from failed or
interrupted turns. Your new request stays separate and is never shortened to make history fit.

Codex receives historical messages directly when its installed version supports that operation.
Other providers receive the same selection as attributed conversation context. A handoff does not
copy the outgoing provider's reasoning, tool-call state, or attachments.

Project knowledge referenced in an earlier message travels with that message exactly as it was
sent, even if the fact has since been edited. Forgotten facts are removed, and excerpts whose
sources were removed or changed are withheld. Retained knowledge counts toward the same history budget.

The handoff includes references to omitted history. The agent can use T3 Code's thread-reading tool
to retrieve saved messages and activity, including the remainder of a long item. For an important
constraint, you can still repeat it in your next message. Unless the project has conversation
summaries turned on, a handoff is a budgeted selection, not a summary.

## Conversation summaries

With conversation summaries on, older history that would not fit in a handoff can arrive as short
summaries instead of being left out. The newest messages still arrive word for word. Each summary is
labelled as model-written and names the messages and tool evidence it was written from, so the
agent can open the exact originals. Long messages and command output are covered in sections,
including the text at the end.

Turn on **Summarize older messages** in **Settings → Labs → Zack**, for one project or every project,
or from **Conversation summaries** in a thread's details on web and desktop. It is off by default
because each summary costs one call to your text generation model. After a turn completes, T3 Code
summarizes settled older history in small batches and continues in the background until it catches
up. You do not need to send more messages to finish an existing backlog.
The most recent messages are never summarized.
Turning summaries off stops both generation and their use in new handoffs. Existing summaries stay
available to inspect and can be used again if you turn the setting back on.

**Conversation summaries** in a thread's details (or thread actions on mobile) lists the thread's
summaries and lets you search their statements and open the evidence behind each one. Large sources
open in bounded pages that can be continued without skipping the rest of the current source. It
also shows what the last pass did, including why it wrote nothing or failed and how many older
sources are still waiting. If a summarized source is edited or removed,
or the thread is deleted or archived, that summary is marked outdated, its text is hidden, and agents
no longer receive it; the changed stretch is summarized again from the current history. Summaries
do not replace a provider's own compaction.

For remote connections, update both the client and server to inspect tool evidence and the complete
text of long sources. Search is available when the server supports it. Older clients can still read compatible
message summaries, but may report that summaries could not be read when an update is needed.

To search conversations created outside T3, open **External history** from this view or from
**Settings → Labs → Zack**. [External history](./external-history.md) can read the selected server's
Codex conversations and configured ChatGPT exports without importing another transcript copy.

## Context limits

A handoff must leave room for existing provider context, your request and attachments, instructions,
tools, and subsequent work. If the target conversation has no room for the handoff, T3 Code starts
a fresh provider conversation with a bounded selection of saved history and sends your request
automatically. You do not need to compact manually. If the request and attachments leave too little
room even in a fresh conversation, shorten the request or select a larger-context model. T3 Code
never shortens your request to make it fit.

Recovery leaves running background work intact. Let it finish or stop it before retrying the handoff.

Server operators can set `T3CODE_CONTEXT_HANDOFF_TOKEN_CAP` to change the initial history allowance
(default 16,000; clamped to 1,024–64,000). This is an upper bound, not a provider context-window
guarantee. Text accounting conservatively charges one token per UTF-8 byte, including attribution
and JSON escaping. Imported history has a separate 64,000-byte ceiling; your current input and
attachment payloads do not consume that ceiling.

T3 Code uses available capacity information for your selected model and options, together with
provider context telemetry. Starting a fresh provider conversation clears prior usage, while keeping
known model capacity. Changing models or context-window options discards stale usage and compaction
thresholds.

When no capacity information is available, T3 Code assumes a 128,000-token window. It reserves at
least 16,000 tokens, or a quarter of the window when larger, for instructions, tools, and subsequent
work. Images reserve an estimated 8,192 tokens each, independent of their file size; other
attachments reserve 4,096 each for their references. Existing context is estimated from saved
activity when usage telemetry is unavailable. Known smaller windows still constrain the handoff.
These are fallback estimates, not exact token counts. Image resolution, custom models, and hidden
native context can differ, so the provider may still reject an input.
