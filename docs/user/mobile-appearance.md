# Mobile appearance

T3 Code Mobile includes the T3 Code, T3 Chat, Grove, Ocean, Ember, and Iris themes. Each theme has
light and dark colors that apply throughout the app, including code reviews, file previews, the
terminal, native headers, and sheets.

To change themes:

1. Open **Settings**.
2. Select **Appearance**.
3. Choose a theme.
4. Select **System**, **Light**, or **Dark**.

**System** follows the device appearance automatically. Theme, text, code, and terminal appearance
preferences are stored on the device. The selected light theme, dark theme, and appearance mode
also follow the connected environment so web, desktop, and mobile clients converge on the same
choices.

## Import a theme

Select **Import theme** and paste a T3 Code ThemeFile v1 JSON object. Imported theme definitions
stay on that device, while their selected IDs still sync. A client that does not have an imported
theme uses **T3 Code** until that theme is installed locally.

Theme colors accept the same literal CSS syntax as the web app, including hex and named colors,
`rgb()`, `hsl()`, `hwb()`, `lab()`, `lch()`, `oklab()`, `oklch()`, and `color()` with the `srgb` or
`display-p3` profile. An unsupported color rejects the entire file.

Mobile accepts up to 20 imported themes. Each file must be 64 KB or smaller, and the full imported
library may use up to 256 KB. Use **Remove** on an imported theme to delete it from the device. If
that theme supplied the selected light or dark appearance, that half returns to **T3 Code**.
