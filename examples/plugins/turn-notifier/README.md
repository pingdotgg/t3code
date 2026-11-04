# Turn notifier

Shows a notification when a turn ends in any thread of the environment, with the thread's title
and whether the turn finished, failed, or was interrupted. If the turn ended but finishing it
failed, for example saving its checkpoint, the notification says so and names the step instead.
The notification offers to open the thread.

Capabilities: `events` (to learn when turns finish, including thread titles) and `notifications`.

## Install

1. Copy this directory to the machine that runs the T3 Code server.
2. In the web or desktop app, connected with administrative access, open **Settings** > **Plugins**, choose **Add plugin** and enter the copy's absolute path.
3. Review the files and capabilities, then choose **Approve and enable**.

Notifications are best-effort: a device that is not connected when a turn finishes may not see
it. When many turns finish at once, some notifications are skipped rather than queued.
