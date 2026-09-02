#!/usr/bin/env node
// Dress the shell in the palette of the terminal this runs in. Asks the
// terminal for its colours over the OSC escape sequences every modern
// emulator answers (10 foreground, 11 background, 12 cursor, 17 selection,
// 4;n the sixteen ANSI slots), maps them onto the theme roles and writes
// theme.json into the shell config dir:
//
//   vp run theme:qt              # $T3CODE_HOME/shell, i.e. ~/.t3/shell
//   vp run theme:qt ~/.t3/shell  # or any directory (or a .json path)
//
// Run it inside the terminal whose colours you want; there is nothing to
// query through a pipe or an editor's task runner. The ANSI slots also land
// in the theme as ansiBlack … ansiBrightWhite for a rice to show.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTty from "node:tty";
import * as NodeURL from "node:url";

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

export const queryTerminal = () =>
  new Promise((resolve, reject) => {
    let fd;
    try {
      fd = NodeFS.openSync("/dev/tty", "r+");
    } catch {
      reject(new Error("no controlling terminal: run this inside the terminal you want to copy"));
      return;
    }
    const tty = new NodeTty.ReadStream(fd);
    tty.setRawMode(true);
    const found = { ansi: [] };
    let buffer = "";
    let timer;
    const finish = (error) => {
      clearTimeout(timer);
      tty.setRawMode(false);
      tty.destroy();
      try {
        NodeFS.closeSync(fd);
      } catch {}
      if (error) reject(error);
      else resolve(found);
    };
    const wanted = 4 + 16;
    const seen = () =>
      ["foreground", "background", "cursor", "selection"].filter((key) => found[key]).length +
      found.ansi.filter(Boolean).length;
    tty.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      // OSC replies: ESC ] <code> ; [<slot> ;] rgb:<r>/<g>/<b> (BEL | ESC \)
      const reply =
        // eslint-disable-next-line no-control-regex -- the reply is an escape sequence
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
    NodeFS.writeSync(fd, queries.join(""));
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
const luminance = (color) => {
  const [r, g, b] = rgb(color).map((c) => {
    const channel = c / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
};

// Every theme role from the terminal's background, foreground and ANSI
// slots. The blue slot is the accent, red / yellow / green / cyan carry the
// semantic roles, and the surfaces step from the background toward the
// palette's bright black (what the terminal draws comments and inactive
// borders in), so panels and hovers keep the palette's tint instead of
// greying out. Hovers, selection and focus lean on the accent.
export const buildTheme = ({ background, foreground, cursor, selection, ansi }) => {
  const bg = background;
  const fg = foreground;
  const dark = luminance(bg) < 0.35;
  const slot = (index, fallback) => ansi[index] ?? fallback;
  const accent = slot(4, slot(12, fg));
  const red = slot(1, slot(9, "#f7768e"));
  const yellow = slot(3, slot(11, "#e0af68"));
  const green = slot(2, slot(10, "#9ece6a"));
  const cyan = slot(6, slot(14, accent));
  // A bright black too close to the background (default xterm) or to the
  // foreground (a light palette with a grey slot) is no use as a tint.
  const brightBlack = slot(8, null);
  const tone =
    brightBlack && contrast(brightBlack, bg) >= 1.3 && contrast(brightBlack, fg) >= 1.5
      ? brightBlack
      : mix(bg, fg, 0.5);
  const raise = (t) => mix(bg, tone, t);
  const tint = (t) => mix(bg, accent, t);
  const onColor = (color) => (contrast(color, bg) >= 3 ? bg : fg);
  const dimmer = (color) => (dark ? mix(color, fg, 0.15) : mix(color, "#000000", 0.35));
  const chrome = dark ? mix(bg, "#000000", 0.28) : mix(bg, "#000000", 0.04);
  const muted = mix(bg, fg, 0.55);
  const border = raise(0.6);
  const colors = {
    canvas: bg,
    chrome,
    toolbar: chrome,
    toolbarForeground: fg,
    toolbarBorder: border,
    toolbarControl: raise(0.45),
    toolbarControlForeground: fg,
    toolbarControlHover: tint(0.28),
    surface: raise(0.3),
    surfaceRaised: raise(0.5),
    surfaceOverlay: raise(0.4),
    text: fg,
    textMuted: muted,
    border,
    input: raise(0.25),
    focus: accent,
    accent,
    accentForeground: onColor(accent),
    secondary: raise(0.5),
    secondaryForeground: fg,
    muted: raise(0.5),
    mutedForeground: muted,
    placeholder: muted,
    secondaryLabel: muted,
    iconMuted: muted,
    info: cyan,
    success: green,
    error: red,
    errorForeground: dimmer(slot(9, red)),
    errorSurface: mix(bg, red, 0.22),
    warning: yellow,
    warningForeground: dimmer(slot(11, yellow)),
    warningSurface: mix(bg, yellow, 0.22),
    update: green,
    updateForeground: dimmer(slot(10, green)),
    updateSurface: mix(bg, green, 0.22),
    accentSurface: tint(0.3),
    accentSurfaceForeground: fg,
    messageSurface: raise(0.3),
    messageForeground: fg,
    messageAction: raise(0.5),
    messageActionForeground: fg,
    messageActionHover: raise(0.7),
    codeBackground: chrome,
    codeForeground: fg,
    sidebar: chrome,
    sidebarForeground: fg,
    sidebarMutedForeground: muted,
    sidebarControlSurface: raise(0.4),
    sidebarRowHover: raise(0.35),
    sidebarRowActive: tint(0.26),
    sidebarRowSelected: tint(0.22),
    sidebarBorder: border,
    terminalBackground: bg,
    terminalForeground: fg,
    terminalCursor: cursor ?? accent,
    terminalSelection: selection ?? alpha(accent, 0.3),
    terminalScrollbar: raise(0.6),
    terminalScrollbarHover: raise(0.9),
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

// The shell config dir the way the app resolves it: T3CODE_HOME, then ~/.t3.
// A directory argument gets theme.json inside it; a .json argument is the
// file itself.
export const resolveOutput = (argument, env = process.env) => {
  if (argument && NodePath.extname(argument) === ".json") return NodePath.resolve(argument);
  const shellDir =
    argument ?? NodePath.join(env.T3CODE_HOME || NodePath.join(NodeOS.homedir(), ".t3"), "shell");
  return NodePath.join(NodePath.resolve(shellDir), "theme.json");
};

const USAGE = `usage: vp run theme:qt [shell-dir | theme.json]

Asks the terminal it runs in for its colours (OSC 10/11/12/17 and 4;n) and
writes theme.json for the Qt shell. Without an argument the file goes to
$T3CODE_HOME/shell (~/.t3/shell); a directory or a .json path picks the spot.`;

const main = async () => {
  const [argument, ...rest] = process.argv.slice(2);
  if (argument === "--help" || argument === "-h") {
    console.log(USAGE);
    return;
  }
  if (rest.length > 0 || argument?.startsWith("-")) {
    throw new Error(`unknown option ${argument?.startsWith("-") ? argument : rest[0]}\n${USAGE}`);
  }
  const output = resolveOutput(argument);
  const found = await queryTerminal();
  if (!found.background || !found.foreground) {
    throw new Error(
      "the terminal did not answer the colour queries (OSC 10/11); try a different emulator or outside tmux",
    );
  }
  const theme = buildTheme(found);
  NodeFS.mkdirSync(NodePath.resolve(output, ".."), { recursive: true });
  NodeFS.writeFileSync(output, `${JSON.stringify(theme, null, 2)}\n`);
  const swatch = (color) => {
    const [r, g, b] = rgb(color.slice(0, 7));
    return `\x1b[48;2;${r};${g};${b}m  \x1b[0m`;
  };
  console.log(
    `${swatch(found.background)}${swatch(found.foreground)}${found.ansi.map(swatch).join("")} -> ${output}`,
  );
};

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
