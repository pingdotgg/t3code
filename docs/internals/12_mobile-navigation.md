# Mobile navigation

Home and thread routes share the [root native stack](../../apps/mobile/src/Stack.tsx) so UIKit
animates headers within one navigation controller; the iPad sidebar has its own stack. See
[Mobile layout](./11_mobile-layout.md) for how the stack maps to columns, sheets, and panes.

## Selecting versus drilling in

Opening a page has two intents:

- **Select** replaces the workspace's active detail page via
  [`selectWorkspaceDetail`](../../apps/mobile/src/features/layout/workspace/workspace-detail-selection.ts),
  preserving route keys when updating in place across phones and splits.
- **Drill in** pushes a page onto the stack with `StackActions.push` so Back returns.

Lint rejects `navigate` to `Thread` or `PullRequest` because its behavior depends on what happens to
be on top. Never infer navigation intent from transition events (UIKit emits them for sidebar
appearances too). Settings pages beside the list share one native screen whose content swaps so
navigating between settings does not pop/push the column or unmount its header.

## UIKit and `react-native-screens` fork constraints

The [react-native-screens fork](../../apps/mobile/deps/README.md#react-native-screens) preserves native header
behavior that is easy to break:

- Keep the brand in `headerTitle` (UIKit on iOS 26.5 morphs a background-free leading toolbar item
  into the next screen's back button).
- Keep the empty native label supplying custom title geometry so UIKit's scroll-edge fade recognizes
  Fabric text views.
- Keep independent caches for leading, trailing, and center item groups (and header config) so
  rebuilding an unchanged group does not pull buttons out of an active UIKit animation.
- Horizontal `ScrollView`s at their leading edge must yield to the full-screen back gesture.
- Register header scroll views only through
  [`NativeScrollViewMarker`](../../apps/mobile/src/native/NativeScrollViewMarker.tsx) or
  `NativeScrollView` (lint enforces this): shifting via bounds origin rather than content offset
  avoids React Native layout passes resetting scroll position under the side bar.

## Native media presentations

- iOS uses AVKit for full-screen video, Quick Look for documents, and our own
  [image viewer](../../apps/mobile/modules/t3-native-controls/ios/T3NativeImageViewer.swift) for
  images (Quick Look drags images during swipe/dismiss). Do not layer a custom UIKit zoom transition
  over AVKit or Quick Look—it breaks AVKit's Close action and Quick Look's interactive dismiss.
- Thumbnail registrations hold weak references and resolve promises only after dismissal so callers
  keep local file leases alive. Treat dismissal as pending until UIKit finishes its transition;
  video cleanup must restore the prior audio configuration without deactivating the shared audio
  session.
- Pin the initial signed asset URL for a video preview's lifetime (reacting to token refreshes
  restarts playback), and copy Quick Look inputs into a temporary directory so preview/sharing
  cannot mutate workspace files.
