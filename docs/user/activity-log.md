# Activity log

On web and desktop, consecutive tool calls appear as an expandable summary. Open it to inspect
commands, tool inputs, status, and exit codes. Expand a tool call to see its output. A running
command's output updates live, and long output shows only its most recent part. Use **Open diff** on
a file change to review its contents.

T3 Orchestrator summaries describe the actions taken, such as **Ran 2 commands and sent messages
to 3 threads**. Repeated messages to the same destinations show both counts: **Sent 5 messages to
2 threads**. Thread creation counts the threads returned by the tool, including batches.

Groups with many kinds of activity show up to two specific action categories and a count of the
remaining actions. Commands, file changes, and orchestration changes take priority over reads and
status checks. Expand the group for the full list.

Failed calls do not count as successful messages or creations. Waiting on a thread does not mean
it finished, and an interrupt or cancellation request does not mean the thread stopped. When tool
details are unavailable, summaries use a broader description instead of guessing how many threads
were affected.

## Hide tool calls

**Tool calls in chat** in **Settings → Chat** (web and desktop) or **Settings → Appearance**
(mobile) hides commands, file edits, searches, and MCP tool calls
from the conversation. **Hide successful** shows a call while it runs and keeps
it only if it fails. **Hide all** hides every call and shows **Thinking** while the agent works.
**Zen** also hides the agent's in-between messages, so each turn shows your message
and the agent's last reply, which appears when the turn ends. If you steer while the agent is
answering, the answer it finished before reading your steer stays too. On web and desktop, Find
shows the in-between messages while it is open. Approvals, questions, and errors always show. The
setting applies to this browser or device only.

## Screen reader announcements

On web and desktop, a screen reader hears the open thread's turn as it runs. **Screen reader
announcements** in **Settings → Chat** sets how much. **Status only** says when a turn starts,
needs your approval or input, and ends. **Status and messages** also reads each message the agent
writes and then keeps working after, once that message is complete. A very long message is cut
short. The reply that closes the turn is not read, so you can read it yourself when you hear
**Done**. **Everything** adds the step the agent is on, such as the command it is running. Steps
are spaced out, so a quick step can be skipped for a newer one.
The agent's reasoning text is never read. The setting follows the agent's real activity, whatever
**Tool calls in chat** hides, and applies to this browser or device only.
