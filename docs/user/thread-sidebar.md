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

## Custom sections

On web and desktop, create a named section from the sidebar's **New section** button or by
right-clicking empty sidebar space. Move one or several threads with **Move to section** in the
thread context menu. Sections start collapsed, and each header shows its thread
count and unread count.

Sections do not expire and new activity does not pull a thread back into the active list. Reading a
thread also leaves it in its section. Snoozing, settling, or pinning temporarily places it in the
corresponding system shelf; waking, un-settling, or unpinning returns it to its custom section.

Right-click a section header to rename or delete it. Deleting a section moves its threads back to
the active list and never deletes their conversation history. Section membership syncs through the
connected server; section order and collapsed state are local to each web or desktop client.

## Environment artwork

Dev and Nightly environments can identify themselves with artwork at the top of the sidebar and in
the send button. Choose **Artwork**, **Version pill**, or **None** in Settings under environment
identification. Artwork is recolored to match each built-in theme. Custom themes use the **Version
pill** fallback because their colors are not controlled by T3 Code.

To generate a fresh title from the conversation, open a thread's context menu and choose
**Regenerate title**. While T3 Code is generating it, the action reads **Regenerating…** and cannot
be selected again. The option is hidden when the connected environment needs a server update.
