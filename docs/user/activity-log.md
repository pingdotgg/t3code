# Activity log

On web and desktop, consecutive tool calls appear as an expandable summary. Open it to inspect
commands, tool inputs, status, and exit codes. Raw command output and tool-result bodies are not
shown. Use **Open diff** on a file change to review its contents.

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

## Explaining a provider error

When a provider fails, an error banner appears at the top of the thread. Choose **Explain** in the
banner to ask your text generation model, the same one that writes thread titles and commit
messages, what probably went wrong. The answer appears in the banner as **What happened** and
**Likely fix**. If the cause is uncertain, the answer says so.

Explain runs only when you choose it, and each use spends credits on the provider behind your text
generation model. The model sees the error text, the provider and model names, the runtime mode, your
last message of that run, how many images it had, and whether each recent action succeeded. It does
not see file contents, command text, tool output, or image names. It runs outside your project folder
with its tools turned off where the provider allows it. If the explanation fails, the banner says so and **Try again** is available. Explain is not
repeated on its own when you reconnect or reopen the thread.

Usage limit errors have no Explain action, because the banner already names the cause.
