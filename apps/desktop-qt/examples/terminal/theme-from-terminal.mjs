#!/usr/bin/env node
// Dress the shell in the palette of the terminal this runs in. Asks the
// terminal for its colours over the OSC escape sequences every modern
// emulator answers (10 foreground, 11 background, 12 cursor, 17 selection,
// 4;n the sixteen ANSI slots), maps them onto the theme roles and writes a
// theme.json next to this file (or to the path given as the first argument):
//
//   node apps/desktop-qt/examples/terminal/theme-from-terminal.mjs ~/.t3/shell/theme.json
//
// Run it inside the terminal whose colours you want; there is nothing to
// query through a pipe or an editor's task runner. The ANSI slots also land
// in the theme as ansiBlack … ansiBrightWhite so shell.qml can show them.
import { openSync, writeFileSync, writeSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ReadStream } from "node:tty";

const ANSI_NAMES = [
  "Black",
  "Red",
  "Green",
  "Yellow",
  "Blue",
  "Magenta",
  "Cyan",
  "White",
  "BrightBlack",
  "BrightRed",
  "BrightGreen",
  "BrightYellow",
  "BrightBlue",
  "BrightMagenta",
  "BrightCyan",
  "BrightWhite",
];

const queryTerminal = () =>
  new Promise((resolve, reject) => {
    let fd;
    try {
      fd = openSync("/dev/tty", "r+");
    } catch {
      reject(new Error("no controlling terminal: run this inside the terminal you want to copy"));
      return;
    }
    const tty = new ReadStream(fd);
    tty.setRawMode(true);
    const found = { ansi: [] };
    let buffer = "";
    let timer;
    const finish = (error) => {
      clearTimeout(timer);
      tty.setRawMode(false);
      tty.destroy();
      try {
        closeSync(fd);
      } catch {}
      error ? reject(error) : resolve(found);
    };
    const wanted = 4 + 16;
    const seen = () =>
      ["foreground", "background", "cursor", "selection"].filter((key) => found[key]).length +
      found.ansi.filter(Boolean).length;
    tty.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      // OSC replies: ESC ] <code> ; [<slot> ;] rgb:<r>/<g>/<b> (BEL | ESC \)
      const reply =
        /\x1b\](\d+);(?:(\d+);)?rgba?:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)(?:\/[0-9a-f]+)?(?:\x07|\x1b\\)/gi;
      let match;
      let consumed = 0;
      while ((match = reply.exec(buffer)) !== null) {
        const [, code, slot, r, g, b] = match;
        const color = `#${[r, g, b].map((c) => c.slice(0, 2).padEnd(2, c[0])).join("")}`;
        if (code === "4") found.ansi[Number(slot)] = color;
        else if (code === "10") found.foreground = color;
        else if (code === "11") found.background = color;
        else if (code === "12") found.cursor = color;
        else if (code === "17") found.selection = color;
        consumed = reply.lastIndex;
      }
      buffer = buffer.slice(consumed);
      if (seen() >= wanted) finish();
      else {
        // Wait a beat for the rest; ESC alone means the user hit Escape.
        clearTimeout(timer);
        timer = setTimeout(() => finish(), 250);
      }
    });
    const queries = ["10", "11", "12", "17"].map((code) => `\x1b]${code};?\x07`);
    for (let slot = 0; slot < 16; slot += 1) queries.push(`\x1b]4;${slot};?\x07`);
    writeSync(fd, queries.join(""));
    timer = setTimeout(() => finish(), 1500);
  });

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const hex = ([r, g, b]) =>
  `#${[r, g, b]
    .map((c) =>
      Math.round(Math.max(0, Math.min(255, c)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
const mix = (a, b, t) => hex(rgb(a).map((c, i) => c + (rgb(b)[i] - c) * t));
const alpha = (color, a) =>
  `${color}${Math.round(a * 255)
    .toString(16)
    .padStart(2, "0")}`;
const luma = (color) => {
  const [r, g, b] = rgb(color).map((c) => c / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

// Every theme role from the terminal's background, foreground and ANSI
// slots. Surfaces are steps from the background toward the foreground; the
// semantic colours are the ANSI red / yellow / green / blue everyone tunes.
const buildTheme = ({ background, foreground, cursor, selection, ansi }) => {
  const bg = background;
  const fg = foreground;
  const dark = luma(bg) < 0.5;
  const slot = (index, fallback) => ansi[index] ?? fallback;
  const accent = slot(4, slot(12, fg));
  const red = slot(1, slot(9, "#ff5555"));
  const yellow = slot(3, slot(11, "#f1fa8c"));
  const green = slot(2, slot(10, "#50fa7b"));
  const cyan = slot(6, slot(14, accent));
  const step = (t) => mix(bg, fg, t);
  const onColor = (color) =>
    luma(color) > 0.55 ? mix(bg, "#000000", dark ? 0.6 : 0) : dark ? bg : "#ffffff";
  const chrome = dark ? mix(bg, "#000000", 0.18) : mix(bg, "#000000", 0.03);
  const muted = step(0.5);
  const colors = {
    canvas: bg,
    chrome,
    toolbar: chrome,
    toolbarForeground: fg,
    toolbarBorder: alpha(fg, 0.1),
    toolbarControl: step(0.08),
    toolbarControlForeground: fg,
    toolbarControlHover: step(0.12),
    surface: step(0.05),
    surfaceRaised: step(0.09),
    surfaceOverlay: step(0.07),
    text: fg,
    textMuted: muted,
    border: alpha(fg, 0.12),
    input: step(0.06),
    focus: accent,
    accent,
    accentForeground: onColor(accent),
    secondary: step(0.09),
    secondaryForeground: fg,
    muted: step(0.09),
    mutedForeground: muted,
    placeholder: muted,
    secondaryLabel: muted,
    iconMuted: muted,
    info: cyan,
    success: green,
    error: red,
    errorForeground: slot(9, red),
    errorSurface: alpha(red, 0.18),
    warning: yellow,
    warningForeground: slot(11, yellow),
    warningSurface: alpha(yellow, 0.18),
    update: green,
    updateForeground: slot(10, green),
    updateSurface: alpha(green, 0.18),
    accentSurface: mix(bg, accent, 0.22),
    accentSurfaceForeground: fg,
    messageSurface: step(0.05),
    messageForeground: fg,
    messageAction: step(0.09),
    messageActionForeground: fg,
    messageActionHover: step(0.14),
    codeBackground: chrome,
    codeForeground: fg,
    sidebar: chrome,
    sidebarForeground: fg,
    sidebarMutedForeground: muted,
    sidebarControlSurface: step(0.07),
    sidebarRowHover: step(0.06),
    sidebarRowActive: step(0.1),
    sidebarRowSelected: step(0.1),
    sidebarBorder: alpha(fg, 0.1),
    terminalBackground: bg,
    terminalForeground: fg,
    terminalCursor: cursor ?? fg,
    terminalSelection: selection ?? alpha(accent, 0.3),
    terminalScrollbar: alpha(fg, 0.12),
    terminalScrollbarHover: alpha(fg, 0.25),
  };
  ANSI_NAMES.forEach((name, index) => {
    if (ansi[index]) colors[`ansi${name}`] = ansi[index];
  });
  return {
    version: 1,
    id: "terminal-palette",
    name: "Terminal palette",
    appearance: dark ? "dark" : "light",
    colors,
    window: { opacity: 1, transparent: false, blur: false, frameless: true },
    radius: "4px",
    fonts: {
      ui: "JetBrains Mono, Menlo, monospace",
      mono: "JetBrains Mono, Menlo, monospace",
    },
  };
};

const main = async () => {
  const output = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "theme.json");
  const found = await queryTerminal();
  if (!found.background || !found.foreground) {
    throw new Error(
      "the terminal did not answer the colour queries (OSC 10/11); try a different emulator or outside tmux",
    );
  }
  const theme = buildTheme(found);
  writeFileSync(output, `${JSON.stringify(theme, null, 2)}\n`);
  const swatch = (color) => {
    const [r, g, b] = rgb(color.slice(0, 7));
    return `\x1b[48;2;${r};${g};${b}m  \x1b[0m`;
  };
  console.log(
    `${swatch(found.background)}${swatch(found.foreground)}${found.ansi.map(swatch).join("")} -> ${output}`,
  );
};

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
