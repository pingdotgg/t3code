# Side chats

In an existing desktop or web conversation, type `/side` and choose the command, or press **Ctrl+Alt+S**. A side panel opens beside the main thread. You can also submit `/side your question` to prefill the side composer.

The side chat captures the main thread’s visible messages and attachments when you open it, including text already streamed by a running answer. It initially uses the same model, reasoning, and access settings in an independent session. Each side composer has its own model, reasoning, access, Build/Plan, and attachment controls. Attach files with the paperclip, drag and drop, or paste images. The main task keeps running; side questions and answers stay separate unless you choose **Send to main chat** beneath a completed answer. This sends the answer immediately through normal thread dispatch, including while the main thread is working, without changing its draft. For large conversations, the provider receives a recent excerpt and a readable local file containing the complete captured snapshot; your new question stays intact. Later main-thread output is not added automatically. Use **+** or `/side` again to take a fresh snapshot in another tab.

Each tab keeps its own unsent draft, attachments, and settings while switching tabs or visiting another thread; responses continue in inactive tabs. The top-right panel toggle hides or shows the entire side-chat pane without creating a tab. Choose **Keep** to move a side chat into the normal thread list. The tab’s **×** discards only that side chat. Temporary side chats remain hidden from the main sidebar and search while their parent is active. If the parent is deleted or archived, its side chats become visible so you can keep working. Reopening `/side` also restores saved temporary conversations and adds a fresh tab.

Drag the divider between the main conversation and side panel to adjust its width. The width is remembered on this device. You can also focus the divider and use Left/Right, Home/End, or double-click to restore the default width. A side question never clears attachments from the main composer.

While open, the snapshot is saved locally for recovery after a reload, rather than relying on a provider-native ephemeral fork. It includes visible conversation content, not hidden provider reasoning or live tool state. Both conversations use the same workspace; this is conversational separation, not a filesystem sandbox. The native mobile app does not yet expose the side panel.

You can also open the thread’s panel launcher and choose **Side chat**, the first option. It is available in both the empty panel and its **+** menu; press **S** while that launcher or menu is focused. Existing tool panels are hidden without closing their sessions.

When you send a new message in the main thread, the side pane offers to close older side chats. Choose **Close older chats** to discard them or **Leave open** to continue. New side chats opened after that message are unaffected.
