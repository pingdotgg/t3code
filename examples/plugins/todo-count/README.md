# TODO count

Gives agents a `count_todos` tool. Given a directory, it counts `TODO` and `FIXME` comments in the
files under it and lists the files with the most. Ask an agent something like "How many TODOs are
left in this project?" and it can call the tool instead of searching file by file.

Capabilities: `tools`. The tool only reads files, on the server's machine, as your user account.
It skips hidden files and folders, `node_modules`, and files over 1 MiB, and stops after 5,000
files.

## Install

1. Copy this directory to the machine that runs the T3 Code server.
2. In the web or desktop app, connected with administrative access, open **Settings** > **Plugins**, choose **Add plugin** and enter the copy's absolute path.
3. Review the files and capabilities, then choose **Approve and enable**.

Agents find plugin tools through T3 Code's `plugin_tools_list` tool. A thread whose agent session
started before you enabled the plugin sees the tool once its session starts again.
