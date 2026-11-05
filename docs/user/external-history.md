# Search conversations outside T3

Open **Settings → Labs → Zack → External history** and turn on **Allow external history search** for the selected environment. The same interface is available from conversation summaries. Web, desktop and mobile use the selected T3 server's sources.

External search reads existing source text. It does not import a conversation as a runnable T3 thread, resume it, generate summaries, or store a second raw transcript. Connected agents can use `t3_external_history` to discover sources, search them, and verify the original text behind a match. Delegated subagents cannot use it.

## Codex

Enable a Codex provider in that environment. External search uses its shared Codex home, including a configured `CODEX_HOME`, and includes interactive CLI, editor and app-server conversations. Multiple provider instances using the same history identity appear once.

Search across projects or supply a directory filter. Archived conversations are included only when **Include archived Codex threads** is selected. The reader requires a Codex app-server version with paged history reads. Unsupported versions and unavailable homes return an error; T3 does not fall back to resuming a conversation.

The source must exist on the selected server. Connecting to a remote T3 server searches that server's Codex history; it does not grant access to conversations stored only on another computer.

## ChatGPT

[Export your ChatGPT data](https://help.openai.com/en/articles/7260999-exporting-your-chatgpt-history-and-data), extract the archive, and add the path to `conversations.json` under **ChatGPT export paths**. Larger exports can contain numbered conversation JSON files; add each file on a separate line. Paths refer to files on the T3 server, including for remote connections.

T3 supports the conversation-array export format with a message mapping and current branch. It searches visible user, assistant and tool text on that branch. Media objects, hidden messages and abandoned branches are excluded. An unsupported export shape or incomplete branch returns an error rather than mixing unrelated branches.

This is access to the configured export, not live synchronization with the ChatGPT app. Replace the export to include newer conversations, then search again. Remove its configured path to stop offering it.

## Search and evidence

Search uses a literal, case-insensitive match against complete visible message or tool text before returning excerpts. Each request examines a bounded page. A page with no matches can still have a continuation; use **Continue search** until the search ends. The examined count describes that page, not the entire archive.

Open a match to read its complete visible evidence in pages. Codex tool records use stable metadata headings followed by their visible output or diff; offsets refer to that representation. A digest binds the result to the complete evidence. Changed or missing sources require a new search. Pages preserve Unicode boundaries; offsets count UTF-16 code units.

Codex responses and selected ChatGPT conversations have an 8 MiB reader budget. Oversized evidence produces an explicit capacity error. ChatGPT files are streamed and unrelated records are discarded; reaching a later conversation currently scans the file prefix again, so very large exports can take longer across successive pages. There is no background import or disk index.

Turning external history off removes it from this environment's search interface and refuses subsequent agent reads. It does not delete the original Codex history or ChatGPT export.
