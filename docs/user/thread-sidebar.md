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

With Sidebar v2 / Thread List v2, finished work moves into a compact settled shelf so active cards
stay focused.

Two independent auto-settle controls decide when a neutral thread settles on its own:

1. **Inactive threads** — settle after a chosen number of quiet days (default: 3). Turn this off to
   keep quiet threads active forever unless you settle them yourself. An open pull request never
   settles from inactivity alone; review can take longer than the window.
2. **Completed pull requests** — settle as soon as a linked pull request is merged or closed
   (default: on). Turn this off to leave those threads on the ordinary inactivity path instead.

On web and desktop these live under Settings → Beta (with Sidebar v2 enabled). On mobile they are
device-local preferences under Settings → Beta (with Thread List v2 enabled), because mobile does
not sync Client Settings.

You can always settle or un-settle a thread from its menu. **Un-settle** is a keep-active choice:
it stays active across later messages and provider activity until you settle that thread again.
Settled threads still wake when real work arrives (a new message, a live session, or an approval /
user-input request).
