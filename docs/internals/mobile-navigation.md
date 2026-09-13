# Mobile navigation

Home and thread routes share the [root native stack](../../apps/mobile/src/Stack.tsx)
so UIKit can animate the header within one navigation controller. The iPad sidebar
has its own stack. Splitting Home and threads between controllers loses that
continuous transition.

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
