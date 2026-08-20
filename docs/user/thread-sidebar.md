# Organizing threads

Threads are grouped first by provider platform and then by project. Threads whose imported session
has no usable project directory appear under **Chats not in a project** at the end of the platform.
See [Importing existing chats](./importing-chats.md) for supported platforms and preserved history.

Select a platform or project heading to collapse or expand its chats. T3 Code remembers these
choices on that device. The **Settled** shelf shows recent settled chats first; use **Show more**
to reveal the next page across all platforms.

Pin a thread from its context menu to keep it in the pinned section above your active work.
Pinned threads are shown independently of their project, including when you connect to more than
one environment.

Hover a thread and select its **…** button to archive or delete it. Archive hides the thread while
keeping its history; delete permanently clears it. Select multiple threads before opening the menu
to archive or delete them together.

On web and desktop, drag a pinned thread to change its position. On mobile, open the thread's menu
and choose **Move up** or **Move down**. The order is stored by the server and appears on your
other connected devices.

If reordering is unavailable for one environment, update the T3 Code server running in that
environment. Older servers can still pin and unpin threads, but do not understand synced ordering;
their pinned threads keep the default newest-first order below the ones you have arranged.

## Environment artwork

Dev and Nightly environments can identify themselves with artwork at the top of the sidebar and in
the send button. Choose **Artwork**, **Version pill**, or **None** in Settings under environment
identification. Artwork is recolored to match each built-in theme. Custom themes use the **Version
pill** fallback because their colors are not controlled by T3 Code.

To generate a fresh title from the conversation, open a thread's context menu and choose
**Regenerate title**. While T3 Code is generating it, the action reads **Regenerating…** and cannot
be selected again. The option is hidden when the connected environment needs a server update.
