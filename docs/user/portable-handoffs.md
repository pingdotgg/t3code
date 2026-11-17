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
summaries instead of being left out. T3 Code also summarizes its summaries, four at a time, so a few
summaries can carry the gist of a whole long thread. A handoff uses the broadest summaries for old
history and finer ones near the newest messages, and uses one only when more history arrives with it
than without it. The newest messages still arrive word for word, but a tool result near the end can
give way to a summary. Each summary is labelled as model-written and names what it was written from:
messages and tool evidence, or the summaries it combines. The agent can open those, and from a
combined summary follow its sources down to the exact originals. Long messages and command output are
covered in sections, including the text at the end.

Turn on **Summarize older messages** in **Settings → Labs → Zack**, for one project or every project,
or from **Conversation summaries** in a thread's details on web and desktop. It is off by default
because each summary costs one call to your text generation model, and combining four summaries
costs one more. After a turn completes, T3 Code summarizes settled older history in small batches,
combines summaries, and continues in the background until it catches up. You do not need to send more messages to finish an existing backlog.
The most recent messages are never summarized.
Summaries use the model selected in **Settings → Threads → Text generation**. If its provider cannot
keep workspace and personal instructions out of summaries, the pass reports that it cannot run.
Choose a supported provider there; T3 Code does not switch your summary model automatically.
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
Claude Code, Codex, Pi, and OpenCode conversations without importing another transcript copy.

## Restart large threads from summaries

A long thread sends its whole history to the provider on every request. With conversation summaries
on, T3 Code can instead continue a large Codex thread in a fresh provider conversation that starts
from the newest messages, word for word, and summaries of everything older. Later requests then
carry far less context.

Set **Restart large threads from summaries** in **Settings → Labs → Zack** to a number of tokens,
for one project or every project. Leave it empty to turn it off, which is the default. It needs
**Summarize older messages** on. When a Codex thread's measured context reaches the number, the next
message you send starts the fresh conversation. A divider in the thread shows that it happened and
how many tokens the old conversation held.

A restart rebuilds the provider's prompt cache once, so T3 Code keeps restarts rare. It restarts only
when the fresh conversation would be at most half the old one, and never twice in a row. It keeps the
current conversation when background work is still running, when summaries have not caught up, for
`/compact` and `/goal`, in group discussions, and whenever any older message would arrive neither
word for word nor in a summary. The provider's own reasoning and tool state do not carry over. The
agent can open a summary's sources to read the exact original text. Rolling back to a turn before a
restart returns to the earlier provider conversation.

Other providers are not affected. Claude keeps its own [idle compaction](./providers-claude.md#compact-long-conversations).

## Context limits

A handoff must leave room for existing provider context, your request and attachments, instructions,
tools, and subsequent work. If the target conversation has no room for the handoff, T3 Code starts
a fresh provider conversation with a bounded selection of saved history and sends your request
automatically. You do not need to compact manually. If the request and attachments leave too little
room even in a fresh conversation, shorten the request or select a larger-context model. T3 Code
never shortens your request to make it fit.

Recovery leaves running background work intact. Let it finish or stop it before retrying the handoff.

Server operators can set `T3CODE_CONTEXT_HANDOFF_TOKEN_CAP` to change the initial history allowance
(default 16,000; clamped to 1,024–64,000). A fresh provider conversation always gets 64,000,
because it has no earlier context to protect. This is an upper bound, not a provider context-window
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
