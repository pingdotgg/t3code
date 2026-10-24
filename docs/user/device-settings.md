# Move device settings between browsers

Device settings, such as fonts, chat width, sidebar and composer behavior, confirmations, and your
theme, are saved separately on each browser and in the desktop app. To set up another browser the
same way, open **Settings → General**, choose **Export**, then choose **Import** on the other
browser and pick the file.

The file lists every device setting, plus your theme, light or dark mode, the theme used for each
half when following the system, and advanced typography. It leaves out settings that belong to one
machine or one environment, such as browser profiles and per-project overrides, and import never
changes those. Environment settings are not included either, since the server keeps those in its
own `settings.json`.

Import lists every setting it will change before anything is saved. Each value in the file replaces
the current one, and a setting the file leaves out keeps its current value, so a hand-written file
with only a few settings works too. A value this version doesn't accept, such as a setting from a
newer version or a theme this browser doesn't have, is skipped and shown as a warning.

The file names your theme but doesn't contain it. To move a custom theme, export it from
**Settings → Appearance** and add it on the other browser before importing.

The file is plain JSON, so you can keep it with your dotfiles and edit it by hand.
