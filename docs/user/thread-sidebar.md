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

## Telling provider instances apart

Each thread row shows the logo of the provider it runs on. When you have configured more than one
instance of the same provider (for example two Claude accounts), the logo also carries a small
colored dot matching the instance's accent color, so you can see at a glance which account a
thread uses. Set the accent color and display name per instance in **Settings → Providers**.
Hovering a thread shows the instance name next to the model, like "Claude Personal · Opus".
