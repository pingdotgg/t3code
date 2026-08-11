# Wallpaper

**Settings → Appearance → Wallpaper** puts an image behind the app. Choose one with **Choose
image…**, or swap it later with **Change image…**. The wallpaper is stored with your other
appearance preferences on the device you set it on, so each of your devices can carry a different
one.

The image is not painted as-is. The active theme's color washes over it, and the workspace canvas
and the sidebar go translucent so it shows through them. Everything above them — cards, message
bubbles, the composer, popovers — keeps its own surface and stays readable. Switching or editing a
theme restyles the wallpaper along with the rest of the app.

**Wallpaper opacity** appears under the wallpaper once an image is set, and controls how much of
the image survives that wash: lower values let more of the theme color through.

To go back to a plain background, use the reset control on the wallpaper row.

## What a wallpaper can be

Any image the browser can paint, including SVG. Large images are scaled down and re-encoded to
keep the preference small enough to store; anything that would still be too large after that, or
that turns out not to be an image at all, is refused with a message on the row rather than being
set.

Animated images keep animating behind the app, which keeps the GPU busy for as long as it is set.
Prefer a static image unless you want that.
