import { msg } from "gt-react";

import { lucideIconNames } from "./lib/lucideIconByName";
export { PROJECT_ICON_COLORS, projectIconColorClassName } from "./projectIconColors";

const POPULAR_PROJECT_ICONS: ReadonlyArray<string> = [
  "folder-code",
  "code-2",
  "terminal",
  "globe-2",
  "server",
  "database",
  "bot",
  "sparkles",
  "smartphone",
  "monitor",
  "cloud-cog",
  "package",
  "book-open",
  "flask-conical",
  "shield-check",
  "rocket",
  "gamepad-2",
  "music",
  "image",
  "shopping-bag",
  "git-branch",
  "workflow",
  "wrench",
  "layers-3",
];

export const PROJECT_EMOJIS: ReadonlyArray<{ readonly emoji: string; readonly label: string }> = [
  { emoji: "💻", label: msg("Computer") },
  { emoji: "🛠️", label: msg("Tools") },
  { emoji: "🚀", label: msg("Rocket") },
  { emoji: "🤖", label: msg("Robot") },
  { emoji: "✨", label: msg("Sparkles") },
  { emoji: "⚡", label: msg("Lightning") },
  { emoji: "🌐", label: msg("Web") },
  { emoji: "📱", label: msg("Mobile") },
  { emoji: "🖥️", label: msg("Desktop") },
  { emoji: "⌨️", label: msg("Keyboard") },
  { emoji: "⚙️", label: msg("Gear") },
  { emoji: "🗄️", label: msg("Database") },
  { emoji: "☁️", label: msg("Cloud") },
  { emoji: "📦", label: msg("Package") },
  { emoji: "📚", label: msg("Books") },
  { emoji: "🧪", label: msg("Test tube") },
  { emoji: "🔒", label: msg("Lock") },
  { emoji: "🎮", label: msg("Game") },
  { emoji: "🎵", label: msg("Music") },
  { emoji: "🎬", label: msg("Movie") },
  { emoji: "🖼️", label: msg("Picture") },
  { emoji: "🛍️", label: msg("Shopping") },
  { emoji: "🔥", label: msg("Fire") },
  { emoji: "💡", label: msg("Idea") },
  { emoji: "🧩", label: msg("Puzzle") },
  { emoji: "📊", label: msg("Chart") },
  { emoji: "🧠", label: msg("Brain") },
  { emoji: "🦄", label: msg("Unicorn") },
  { emoji: "🐙", label: msg("Octopus") },
  { emoji: "🌱", label: msg("Seedling") },
];

export function filterProjectIconNames(query: string): ReadonlyArray<string> {
  const normalized = query.trim().toLowerCase().replaceAll(/\s+/g, "-");
  if (!normalized) return POPULAR_PROJECT_ICONS;
  return lucideIconNames.filter((name) => name.includes(normalized)).slice(0, 60);
}

export function firstEmoji(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(trimmed);
  const segment = segments[Symbol.iterator]().next().value?.segment;
  const isFlag = /^\p{Regional_Indicator}{2}$/u.test(segment ?? "");
  const isKeycap = /^[#*0-9]\uFE0F?\u20E3$/u.test(segment ?? "");
  if (!segment || (!/\p{Extended_Pictographic}/u.test(segment) && !isFlag && !isKeycap)) {
    return null;
  }
  return segment;
}
