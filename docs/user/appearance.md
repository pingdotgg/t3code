# Appearance

Use **Settings → Appearance** to choose whether T3 Code follows the system light or dark mode and
to select a built-in theme.

On mobile, **Import theme** accepts a pasted T3 Code ThemeFile v1 JSON object. Imported themes are
stored on that device and appear after the built-in themes. A theme may define light colors, dark
colors, or both; T3 Code uses its standard colors when the selected theme does not provide the
current appearance.

Theme colors support hex literals, CSS named colors, `rgb()`/`rgba()`, `hsl()`/`hsla()`, `hwb()`,
`lab()`, `lch()`, `oklab()`, `oklch()`, `color(display-p3 ...)`, and `color(srgb ...)`. A single
unsupported color rejects the whole theme file.

Mobile supports up to 20 imported themes. Each theme file must be 64 KB or smaller, and the full
imported-theme library may use up to 256 KB of device storage.

Use the remove button on an imported theme to delete it from the device. Removing the selected
theme switches back to **T3 Code**. Built-in themes cannot be removed.
