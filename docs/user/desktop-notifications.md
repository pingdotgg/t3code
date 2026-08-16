# Notifications

The T3 Code desktop app and supported web browsers can send system notifications while T3 Code is
in the background and an agent needs your attention or finishes work. Browser notifications require
the site to remain open and connected; T3 Code does not send push notifications after you close it.

Open **Settings** → **General** → **Notifications**, then turn on **Enable notifications**. The web
app asks for notification permission when you enable it. Use **Send test** to confirm that your
browser or operating system allows notifications.

Choose which events can notify you:

- **Approval needed** when an agent is blocked on an approval
- **Waiting for input** when an agent asks a question or needs more direction
- **Agent finished** when a turn completes
- **Agent failed** when a provider or turn ends with an error

Starting and routine working updates do not create notifications. The desktop app stays silent while
its window is focused. The web app stays silent while its tab or another connected T3 client is
focused. Opening a notification focuses T3 Code and takes you to the relevant environment and thread.

The desktop app takes priority for an environment whenever it is connected, even while its window
is in the background. Browsers connected to that same environment stay silent, preventing a native
and browser notification for the same event. Without a connected desktop app, each browser device
where you enabled notifications can notify you; multiple tabs in one browser profile are deduplicated.

The title and message text are identical on macOS, Windows, Linux, and the web. The browser and
operating system control the notification's visual style, placement, timing, and permission settings.
Completion notifications use the thread title and a short preview of the agent's final response. If
the response is unavailable, they show the project name instead.

Turn off **Play sound** for silent notifications. Turn off **Show thread names** to replace project
and thread names, including completion previews, with a generic message on shared screens.

Notification preferences are local to each desktop installation or browser profile. T3 Code treats
the first thread snapshot after launch as current state, not a notification backlog, so reconnecting
does not replay old completions or failures.
