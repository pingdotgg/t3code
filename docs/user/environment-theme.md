# Environment theme

Some desktops publish the palette they are currently wearing so that apps can match it. When the
machine running your T3 Code server does that, its themes appear in the theme library alongside
your own, and T3 Code follows them: change the desktop theme and T3 Code retints with it, without
a restart.

To use one:

1. Open **Settings**.
2. Select **Appearance**.
3. Choose the theme published by your environment.

Like every theme, this is a per-client choice: picking it on your desktop does not change what your
phone or another browser shows.

The machine can also set the environment's theme:

```bash
t3 theme set nightfall
```

Web and desktop clients switch to it — immediately when connected, on their next connect
otherwise — and a fresh client opens with it. Each client applies a set once, so picking a
different theme in Settings afterwards sticks until the next `t3 theme set`, and running the same
set again is how you bring clients back. `t3 theme clear` removes the setting without changing
what anyone currently has, and `t3 theme show` prints the current theme and everything the
machine publishes. Only the environment you are anchored to publishes themes, so a remote client
follows the machine it is connected to, not the device it runs on. T3 Code Mobile keeps its own
appearance settings and does not follow environment themes.

Select **Duplicate** on a published theme's card to keep a copy you can edit. The published theme
itself cannot be edited or removed, because the environment rewrites it whenever its own theme
changes. If the machine stops publishing it, the card disappears and clients using it fall back to
the standard T3 Code look. A theme you saved always wins over a published one with the same id.

When the theme editor is open, its draft stays visible while published themes change.
Close the editor to show the latest selected theme.

## Publishing themes

A machine publishes themes by writing files into the `themes` directory of the T3 Code state
directory (`~/.t3/userdata/themes/` by default). The filename is the theme id — `nightfall.json`
appears as `nightfall` — and stays stable while the machine rewrites the colors underneath, so
selections and defaults keep pointing at it.

The filename may not be an appearance keyword (`system`, `light`, `dark`) or a built-in theme's
id — those names already mean something on every client. Two formats are accepted. A theme
exported from T3 Code (the **Download** button's output) works as-is, so any theme someone shared
can be dropped in unchanged. Or, for a desktop that only knows
its own palette, a short seeded form:

```json
{
  "name": "Nightfall",
  "appearance": "dark",
  "canvas": "#1a1b26",
  "accent": "#7aa2f7"
}
```

`appearance` is `light` or `dark`, and `canvas` and `accent` are hex colors. T3 Code generates the
rest of the palette from those two, the same way the guided theme editor does, so the result reads
as a T3 Code theme wearing your desktop's colors rather than a transplant of another app's.

A machine that knows a role better than a derivation can guess — its terminal palette, its
semantic colors — can publish that role directly under `colors`, layered over the generated
palette:

```json
{
  "name": "Nightfall",
  "appearance": "dark",
  "canvas": "#1a1b26",
  "accent": "#7aa2f7",
  "colors": {
    "terminalSelection": "#292e42",
    "error": "#f7768e"
  }
}
```

Any of the roles shown in the theme editor's advanced view can be published this way; roles left
out keep their generated value. A role this version of T3 Code does not know is ignored rather
than rejected, so publishing a role added by a newer release is safe. An `id` inside the file is
ignored — the filename decides.

A theme with no usable colors is not listed on that client.

Write each file atomically — write a temporary file beside it and rename — so T3 Code never reads
a half-written theme. An unreadable or invalid file is simply not published; the machine's other
themes are unaffected.
