# Guest links

A guest link lets a teammate follow one thread in their browser and ask the agent questions, with no
account. They see your messages and the agent's replies as they stream. Each message they send waits
until you send or dismiss it.

## Share a thread

Guest links need [T3 Connect](./remote-access.md), because the link points at your machine's
T3 Connect address. Your machine must stay online while the guest uses it.

1. Right-click the thread in the sidebar and choose **Share with guest**. It is also in the thread
   menu and the command palette.
2. Copy the link and send it to one person. It works in one browser and expires after 24 hours.
   Opening it again in that browser takes them back to the thread.
3. When they send a message, it appears at the end of the thread and the sidebar shows **Request**.
   Choose **Send** to run it as a normal turn, or **Dismiss**.

Choose **Stop sharing** to end the link at once. Archiving the thread, creating a new link, or
unlinking the machine from T3 Connect also ends it. You can send or dismiss guest messages from the mobile app.

## What the guest sees

The guest sees the last three turns before you shared the thread and everything after, in the same
timeline you see, as it streams. They see messages, plans, the agent's questions, and its work:
commands and their output, file names, searches, and tool names. Their composer shows the thread's
model, but they cannot change it. They do not see diffs, the agent's reasoning, tool results other
than command output, or what you answer in approval prompts.

Command output and the agent's replies can show something it read, such as a value from a file.
Share only threads you are comfortable showing.

The guest's text runs with the thread's current permission mode once you send it. Read it before you
choose **Send**, as you would read anything pasted from a chat.
