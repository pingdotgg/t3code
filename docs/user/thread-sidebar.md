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

## Linking to a thread

Open a thread's context menu and choose **Copy → Link** to put its address on the clipboard. In a
browser the link uses the address you are already on; in the desktop app, which has no address bar,
it uses the address this client reaches the environment at — a `localhost` address for a server on
this machine, or its tunnel address when you connect remotely.

The link opens the thread on any device that can reach that address and is paired with the
environment, so it is worth checking that the address is one the other device can reach before you
send it. It is not a public share link: someone without access to the environment cannot read the
thread through it.

## Environment artwork

Dev and Nightly environments can identify themselves with artwork at the top of the sidebar and in
the send button. Choose **Artwork**, **Version pill**, or **None** in Settings under environment
identification. Artwork is recolored to match each built-in theme. Custom themes use the **Version
pill** fallback because their colors are not controlled by T3 Code.

To generate a fresh title from the conversation, open a thread's context menu and choose
**Regenerate title**. While T3 Code is generating it, the action reads **Regenerating…** and cannot
be selected again. The option is hidden when the connected environment needs a server update.
