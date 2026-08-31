# Reasoning in a thread

Some providers report the thinking they do before answering. Each burst of it becomes one
collapsible row in the thread timeline, tucked under the turn's **Worked for …** group with the
tools the agent ran. The row reads **Thinking…** while it arrives and **Thought for 4s** once it
finishes. It collapses on its own when the thinking ends, so the answer stays the thing you see.
Click the row to read it.

Delivery follows the same setting as assistant text. With **Stream token by token (legacy)** on in
**Settings → General**, thinking streams in as it is produced. With it off, which is the default,
each thought appears as one finished block.

Reasoning never changes the outcome of a turn. It does not keep a turn from settling, it is not
part of checkpoints or turn diffs, it never becomes a thread title, and thread search and the
timeline's jump markers skip it.

## Where it shows up

Claude, Codex, and OpenCode report reasoning. Cursor and Grok do not, and their threads look the
same as before. Thoughts appear on web and desktop. The mobile app does not show them yet.

For Claude, what you read is a summary of the thinking rather than the model's raw words. Recent
Claude Code versions do not hand out raw thinking, so T3 Code asks for the summarized form.
