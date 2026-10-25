# Mobile navigation

Home and thread routes share the [root native stack](../../apps/mobile/src/Stack.tsx)
so UIKit can animate the header within one navigation controller. The iPad sidebar
has its own stack. Splitting Home and threads between controllers loses that
continuous transition.

## Selecting versus drilling in

Opening a page has two intents, and each has one action:

- **Select** shows a thread or pull request as the workspace's only page, the
  way a list row does. Everything that selects (rows, the command palette,
  compose, notifications, deep links) uses
  [`selectWorkspaceDetail`](../../apps/mobile/src/features/workspace/workspace-detail-selection.ts),
  which the root stack's router handles. The resulting stack is the same on
  phones, collapsed splits, and expanded splits. Only route keys differ: the
  page already showing keeps its key, so the detail column updates in place
  instead of pushing.
- **Drill in** opens a page over the current one so Back returns, with
  `StackActions.push`.

`navigate` to `Thread` or `PullRequest` is rejected by lint, because it pushes
or updates in place depending on what happens to be on top. Never infer the
choice from transition events: UIKit reports the sidebar column appearing in
split views too. The one native signal the router uses is the card native Back
is popping. The workspace navigator reports it, and a selection never reuses
that card.

Beside the list, Settings pages share one native screen whose content swaps,
like the system Settings app. A route per page would pop and push the column,
and would unmount its header configuration, which hides the navigation bar.

## UIKit constraints

The [react-native-screens patch](../../patches/react-native-screens@4.26.2.patch)
preserves behavior that is easy to break when changing native headers:

- The brand belongs in `headerTitle`. On iOS 26.5, UIKit morphs a background-free
  leading toolbar item's rectangle into the next screen's glass back button,
  even when the items have different identifiers.
- UIKit's scroll-edge fade does not recognize Fabric text views. An empty native
  label supplies the custom title's geometry. Removing that apparently unused
  view changes the fade.
- Leading, trailing, and center item groups need independent caches. A button can
  belong to only one group; rebuilding an unchanged group can pull its buttons
  out of a group UIKit is still animating. Cache ownership also includes the
  header config, whose event emitter changes on remount.
- A horizontal ScrollView at its leading edge must yield to the full-screen back
  gesture. Upstream gives every horizontal ScrollView priority, so swiping back
  on a code block or table can only bounce its content.
- UIKit draws the header's scroll-edge blur inside the scroll view, and workspace
  columns pad their content away from the iPhone Duo's vertical bar. Register a
  header scroll view only through
  [`NativeScrollViewMarker`](../../apps/mobile/src/native/NativeScrollViewMarker.tsx)
  or `NativeScrollView`: their native wrapper widens the scroll view under that
  bar, so the blur reaches it while the content stays in the safe area. On the
  left it shifts React Native's content view back through its bounds origin,
  never with a content offset: React Native rewrites offsets on its own layout
  passes, which left threads shifted under the bar. Lint rejects
  `ScrollViewMarker` imported anywhere else.

The patch adds native header props that require code generation and a new binary.
Patch rebuild guidance lives in the
[mobile development README](../../apps/mobile/README.md#development).

## Native media presentations

iOS delegates full-screen video to [AVKit](../../apps/mobile/modules/t3-native-controls/ios/T3NativeVideoPresentation.swift)
and images and documents to [Quick Look](../../apps/mobile/modules/t3-native-controls/ios/T3NativeFilePresentation.swift).
Each framework owns its controls and transition. A separate UIKit zoom transition
prevents AVKit's native Close action from exiting full screen and interferes with
Quick Look's interactive return to its thumbnail. The AVKit entry selector is
guarded, with standard modal presentation as the fallback.

[Thumbnail registration](../../apps/mobile/modules/t3-native-controls/ios/T3NativePresentation.swift)
holds weak view references for transition and share-sheet anchors. It does not own
the preview; a source row can disappear while a native presentation is open.
Identifiers must distinguish attachments that are visible at the same time.
Native promises complete after dismissal so callers keep local file leases until
the preview or share flow has finished.

Treat a dismissal request as pending until UIKit finishes its current transition.
Starting another dismissal while presentation or an interactive dismissal is
settling can strand the controller. Video cleanup restores the previous audio
configuration only if it still matches the preview's configuration. It must not
deactivate the shared audio session, which may belong to another player or recorder.

Video playback holds the first signed asset URL for the lifetime of the preview.
Following credential refreshes reactively would restart playback. Quick Look copies
original bytes into its own temporary directory so preview and sharing cannot
mutate a draft or workspace file.
