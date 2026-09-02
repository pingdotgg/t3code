# Mobile navigation

The iOS Home and thread routes share the root native stack in
[`Stack.tsx`](../../apps/mobile/src/Stack.tsx). Keeping them in one navigation
controller lets UIKit animate the header between routes. The iPad sidebar owns
a separate, single-screen stack; Android uses its own in-flow headers.

Home and the iPad sidebar render their brand and connection status through
`headerTitle`, with `Threads` retained as the route title. The editor-style native
bar aligns that title on the leading side. Do not model the brand as a toolbar
button: on iOS 26.5 UIKit morphs a background-free custom leading item's rectangle
into the next screen's glass back button, even with distinct item identifiers.
Using the title slot lets the brand and native back button animate separately.

The connection-status title has a maximum width based on its header's width and
trailing actions. A long environment name or larger text must not push Settings
into UIKit's overflow menu. Keep the full status as the accessibility label
while visually truncating it. The iPad sidebar uses its pane width, not the full
window width.

On iOS 26, UIKit does not recognize Fabric's custom text views when shaping the
native scroll-edge fade. The screens patch gives custom title subviews an empty,
non-interactive native label matching their bounds. This supplies the fade's
geometry without drawing anything or turning the title back into a toolbar item.
Check the top scroll fade as well as push/pop when changing these title views.

The react-native-screens patch caches leading, trailing, and center item groups
independently. A button can belong to only one group: constructing another group
with the same button removes it from the previous one. Unrelated menu updates
must therefore preserve the other groups while UIKit may be animating them.

Each cache includes the owning header config, its item values, and custom native
item identities, so changed content or remounted event emitters still rebuild.

Custom header identifiers require native code generation and a new mobile build;
an over-the-air JavaScript update alone is insufficient. The Android view manager
implements the generated identifier setter as a no-op because this behavior is
specific to iOS 26 and later.

After changing a dependency patch, refresh CocoaPods before rebuilding an
existing iOS project. pnpm installs each patch hash in a different directory;
an old Pods project can keep compiling the previous directory even though Metro
and `apps/mobile/node_modules` resolve to the new patch.

`ControlPillMenu` resolves semantic icon colors through `withUniwind` and supplies them to every
iOS `MenuView` action, including nested actions. The menu library's Fabric bridge converts a missing
`imageColor` to transparent, so callers should use this wrapper instead of
rendering `MenuView` directly. Explicit colors are preserved, and destructive
actions default to the theme's danger foreground color. Native stack header menus
use a separate implementation and do not need this workaround.

## Native media presentations

`PresentationSource` in `NativePresentation` registers a thumbnail for AVKit,
image zoom transitions, and UIKit's share sheet. Wrap the thumbnail as its single child
and pass the stable identifier to the presentation. The registry keeps weak
references to source views; recycled or compact composer thumbnails can register
the same identifier. Identifiers must distinguish simultaneously visible attachments.
The source registration does not own the preview. Android uses a regular view.

On iOS, video previews mount `AVPlayerViewController` temporarily inside the
registered source and enter full screen through AVKit. AVKit
owns that zoom, its playback controls, Close button, and interactive dismissal.
Do not replace AVKit's transition with `preferredTransition`: in the iOS 27
simulator, that leaves native Close unable to exit full screen. When the source is unavailable,
the player uses a standard modal presentation. Programmatic entry uses the same
guarded `enterFullScreenAnimated:completionHandler:` selector as Expo Video;
if that selector is unavailable, the player also falls back to a standard modal.

`FilePreviewModal` resolves image and PDF sources from a URI, a signed environment asset,
or a retained composer file. On iOS, Quick Look owns image and document layout, controls,
zooming, sharing, and interactive dismissal. Its delegate supplies the registered thumbnail
and its bounds for Quick Look's source-view zoom. Do not layer `preferredTransition` or
another image scroll view over that presentation: Quick Look coordinates its image gestures
with the return to the thumbnail. Missing sources use the standard transition, and Reduce
Motion disables animation. A pending programmatic Close waits until the current presentation
or cancelled dismissal has settled before starting another transition.

The shared native presenter copies original bytes into its own temporary directory and
removes that copy after dismissal. Network downloads write to disk, and sharing never edits
the source attachment. Draft images use their stored upload data rather than a potentially
expired picker URI. No React Navigation route or custom transition animator is needed.

The same viewer handles message images, markdown images, PDF attachments and links,
composer thumbnails, and workspace image previews. The workspace PDF web preview has an
Open PDF action for the native viewer. Android retains its image viewer and uses the
system chooser for PDFs. Saving images on iOS uses the add-only photo-library permission.

Received videos open directly from their signed asset URL. AVKit handles buffering;
the client does not download the entire file or show a separate opening overlay before
presentation. The URL is captured once per preview so credential refresh does not
restart playback. Saving or sharing still downloads the original file.

The native presentation promise completes after dismissal. Local draft previews
hold their file lease until that promise settles. The iOS preview component requests
native dismissal when its source screen unmounts. Playback pauses in the background.
AVPlayer activates audio as playback starts. The presenter pauses and releases
its own player on close, then restores the previous audio-session configuration
if no other component changed it during playback. It does not deactivate the
shared session, which may still serve another player or recorder. Android retains
its React Native modal and Expo Video player.

`shareFileFromSource` uses the same source registration to anchor UIKit's activity
controller. Its promise completes when the native share flow finishes, keeping
the existing attachment lease and foreground handoff active for that duration.
Android uses Expo Sharing. On iOS, received and draft video attachments expose
Save or share through `VideoAttachmentMenu`. The attachment supplies the source
identifier, and the native share presentation inherits its appearance. AVKit's
iOS playback controls do not expose a public custom-share-action API.

Video attachment thumbnails use Expo Video's native frame extraction and Expo Image.
Received attachments use their signed asset URL; drafts retain and resolve their local file
until extraction ends. Extraction is serial; temporary players never play or change audio settings. Leaving the screen cancels
pending work; a 15-second limit prevents an unreachable source from holding up the queue.
The client keeps at most 32 native images, each bounded to 480 pixels per side, keyed by
environment and attachment identity rather than expiring URLs. Images still displayed keep
their own references when evicted from that cache.

The asset HTTP route supports single byte ranges for videos so iOS can read metadata and
frames without first downloading the whole file. Normal downloads keep their full response;
unsupported ranges and conditional `If-Range` requests also fall back to the full file.
An older environment without range support may still show the play-card fallback. Thumbnail
failure never disables playback or sharing.
