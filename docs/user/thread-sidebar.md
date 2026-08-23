# Organizing threads

The sidebar groups threads into Pinned, Regular, Snoozed, and Settled. On web and desktop, drag
any thread between these sections. The sidebar keeps the dragged thread under the pointer and holds
your scroll position while a section appears or changes.
Empty Pinned, Snoozed, and Settled sections appear as drop targets while you drag.

The destination chooses the thread's state:

- Drop in **Pinned** to pin it at that exact position. Pinned threads are shown independently of
  their project, including when you connect to more than one environment.
- Drop in **Regular** to unpin, wake, or un-settle it as needed. Regular keeps its normal sort
  order.
- Drop in **Settled** to settle it. Settled threads keep their normal history order.
- Drop in **Snoozed** to open the usual snooze menu. Choose when the thread should wake. Snoozing
  removes it from the other sections, and the row or confirmation toast can wake it again.

Pinning, settling, waking, and un-settling happen automatically when you drop. Snooze and Settled
are sorted sections, so their order is not manually stored. Pinned is the only section with a
user-controlled order.

Pinned threads can still move to **Settled** when they become inactive. They also move when their
pull request merges if **Auto-settle merged threads** is enabled. The pin remains visible there.

You can also pin or settle a thread from its context menu.

On mobile, open a pinned thread's menu and choose **Move up** or **Move down**. The order is stored
by the server and appears on your other connected devices.

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
