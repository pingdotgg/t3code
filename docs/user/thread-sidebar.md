# Organizing threads

Pin a thread from its context menu to keep it in the pinned section above your active work.
Pinned threads are shown independently of their project, including when you connect to more than
one environment.

On web and desktop, drag a pinned thread to change its position. On mobile, open the thread's menu
and choose **Move up** or **Move down**. The order is stored by the server and appears on your
other connected devices.

If reordering is unavailable for one environment, update the T3 Code server running in that
environment. Older servers can still pin and unpin threads, but do not understand synced ordering;
their pinned threads keep the default newest-first order below the ones you have arranged.

## Settling threads

T3 Code can automatically move inactive threads and threads with a merged or closed pull request
to the settled section. These are separate preferences: disabling inactivity auto-settlement does
not disable completed-pull-request auto-settlement.

On web and desktop, keep every thread active until you settle it yourself by opening
**Settings → General** and disabling both **Auto-settle inactive threads** and **Auto-settle
completed pull requests**. Those clients share both preferences.

Mobile stores **Auto-settle completed pull requests** on the device. Disabling it prevents a merged
or closed pull request from settling a thread, but inactive mobile threads still settle after three
days. An open pull request continues to keep its thread active regardless of the inactivity setting.
