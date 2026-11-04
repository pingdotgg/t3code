# Machine label

Shows a label, such as "Build box" or "Laptop", in the status area of each thread after a turn
finishes there, so threads from different machines are easy to tell apart. Without a label it
shows the machine's host name.

Capabilities: `events` (to learn when turns finish), `settings` (the label and its color), and
`status` (to show the label).

## Install

1. Copy this directory to the machine that runs the T3 Code server.
2. In the web or desktop app, connected with administrative access, open **Settings** > **Plugins**, choose **Add plugin** and enter the copy's absolute path.
3. Review the files and capabilities, then choose **Approve and enable**.
4. Optional: set **Label** and **Color** under the plugin's name in **Settings** > **Integrations**
   (same administrative web or desktop connection; mobile shows the saved values read-only).

A changed label shows after the thread's next turn. The 16 threads with the most recent turns keep
a label. Labels disappear when the server restarts and come back as turns finish.
