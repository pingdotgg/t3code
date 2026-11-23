# Conversations and study

Kompas opens in chat mode: a conversation with the model you pick, with no project or repository behind it. Type a question, drop in notes or a photo, and ask for whatever helps: flashcards, a quiz, a chart, a diagram, a map, a timeline, a table or an interactive plot. Widgets work in both themes and on the phone; the expand button opens one full screen, and **Ask about this** puts it into your next message.

You can change the model in the middle of a conversation. The new model gets a summary of what was said and the same memory, so it continues where the last one stopped.

A conversation works in a private folder of its own (`scratch` in the data folder) and starts with edits allowed there but commands asking first. The coding tools, such as branches, diffs, the terminal and pull requests, are hidden. Turn on **Settings → General → Developer mode** to get them back; your conversations stay where they are.

## Plugins

A plugin is an [MCP](https://modelcontextprotocol.io) server that Kompas connects to once and offers to every model. **Plugins → Add** has web search from Exa, which works without a key, and Tavily, which asks you to sign in. **Add your own** takes a web address or a command on the computer that runs Kompas.

Keys and sign-ins stay in that computer's secret store. Models call the plugin through Kompas and never see them. A plugin can be on everywhere or only where you turn it on with its button under the message field, and you can switch off single tools. Changes apply from the next conversation on. In chat mode, models do not use the MCP servers or connectors you set up in their own apps, so every model has the same tools.

## Memory

**Memory** shows what every model reads when a conversation starts: your profile, the assistant's notes, and one section per project. Each has a size limit, shown as a bar; a model that runs out of room has to tidy up first. Models add to it as you talk and show a note with **Undo**. Turn on **Ask me before a model remembers something** to approve each entry. You can edit and delete any entry, and search your past conversations from the same page.

Memory is read once, at the start, so an edit reaches a running conversation only when it restarts. The agents' own memory files are not used in chat mode.

## Flashcards

Ask for flashcards and the deck appears in the conversation and under **Study**. Reviews are spaced with FSRS: rate how well you knew a card and it returns when you are about to forget it. In a review, press Space to flip and 1 to 4 to rate; on the phone, tap to flip and swipe right for good or left for again. **Explain this card** opens a conversation about it. Decks export as CSV, which Anki and spreadsheets read.

On the phone, **Settings → Mode and reminders** schedules a daily notification. The phone sends it by itself, so it comes even when your computer is off.

## Projects

A project is for something larger than one conversation, such as exam preparation. You talk with its coordinator, which splits the work into threads, follows them, and keeps the results in the project's library. The coordinator proposes threads for you to start and asks when a decision is yours; both wait under **Overview**, and the sidebar counts what waits for you. Turn off **Ask me before a thread starts** in the project's settings to let it start threads by itself, up to the limit you set.

Threads are grouped by what they need: waiting for you, working, ready to check, failed, and done. A thread is done when you say so. Project memory is read only by that project's threads.
