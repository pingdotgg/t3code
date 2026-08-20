# Android GLB previews

> For maintainers. Using T3 Code? See [Files on mobile](../user/mobile-files.md).

Android renders binary glTF files from the mobile Files tab with a local Expo view backed directly
by Google Filament's `ModelViewer`. The integration intentionally does not use a WebView, add a
Compose scene hierarchy, or depend on the alpha SceneView React Native bridge.

## Data flow

1. `ThreadFileScreen` offers the preview when `hasNativeGlbViewer()` reports the native view is
   present in the installed binary, then requests the existing `workspace-file` asset URL.
2. The server issues an exact-file capability for the GLB. Only browser documents get a
   directory-scoped capability, so the GLB token cannot read sibling files.
3. `T3GlbViewerView` streams the signed URL into a bounded cache file off the main thread, rejects
   files over 100 MB, and validates the GLB 2.0 header and declared length before memory-mapping it
   for Filament. This avoids retaining duplicate model-sized Java heap buffers.
4. Filament normalizes the model into the camera view, plays up to 10 seconds of its first animation
   once, and supplies native orbit, pan, and zoom gestures.

The existing asset URL keeps local, remote, relay, and tunnel connections on one path. No Android
filesystem path is exposed to the client.

## Lifecycle and performance

The renderer uses Filament's supported `SurfaceView` path, with the surface below React Native's
screen chrome. It renders only while the surface is ready, attached, and window-visible, and it
parks the render loop once the scene stops changing, so a still model costs nothing to keep on
screen. Frames resume on touch and keep flowing while the model streams in or an animation plays.
An animation runs for at most 10 seconds and then holds its actual final pose rather than looping,
so an animated model parks like a still one; a tap replays it. The sustained loop is throttled to
~30 frames per second; the first frame after a wake-up (touch, attach, visibility) is posted
immediately so gestures stay responsive. In-flight downloads are cancelled when the view detaches.
Detaching drops the viewer reference and a new one is built if React Native reattaches the screen,
so a detach/reattach cycle re-creates the Filament engine and refetches the model.

The module lives at `apps/mobile/modules/t3-glb-viewer`. Changing it or its Filament dependency
changes the Expo native fingerprint and requires a new Android build; an over-the-air JavaScript
update cannot add the native viewer to an older binary. `hasNativeGlbViewer()` detects that case, so
the Files tab declines the preview rather than requiring a missing native view, and the file falls
back to the "3D preview unavailable" notice shown on platforms without the viewer.

Filament is pinned in the module's Gradle file. When upgrading it, compare `ModelViewer` lifecycle
and loading APIs against the matching release, then rebuild and exercise a textured, animated GLB
on a representative Android device.
