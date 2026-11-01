# Activity log

Follow the agent's thinking as it works. Consecutive tool calls share one row. Open the row to see
the calls, then select a call to inspect its output. A single call opens directly. When the turn
finishes, select **Worked for…** above the answer to see its thinking and tool calls again.

On web and desktop, a running command's output updates live. Long output shows its most recent
part. Use **Open diff** on a file change to review its contents.

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
