import { t } from "@palamedes/core/macro";
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
  {
    emoji: "💻",
    get label() {
      return t({ message: "Computer" });
    },
  },
  {
    emoji: "🛠️",
    get label() {
      return t({ message: "Tools" });
    },
  },
  {
    emoji: "🚀",
    get label() {
      return t({ message: "Rocket" });
    },
  },
  {
    emoji: "🤖",
    get label() {
      return t({ message: "Robot" });
    },
  },
  {
    emoji: "✨",
    get label() {
      return t({ message: "Sparkles" });
    },
  },
  {
    emoji: "⚡",
    get label() {
      return t({ message: "Lightning" });
    },
  },
  {
    emoji: "🌐",
    get label() {
      return t({ message: "Web" });
    },
  },
  {
    emoji: "📱",
    get label() {
      return t({ message: "Mobile" });
    },
  },
  {
    emoji: "🖥️",
    get label() {
      return t({ message: "Desktop" });
    },
  },
  {
    emoji: "⌨️",
    get label() {
      return t({ message: "Keyboard" });
    },
  },
  {
    emoji: "⚙️",
    get label() {
      return t({ message: "Gear" });
    },
  },
  {
    emoji: "🗄️",
    get label() {
      return t({ message: "Database" });
    },
  },
  {
    emoji: "☁️",
    get label() {
      return t({ message: "Cloud" });
    },
  },
  {
    emoji: "📦",
    get label() {
      return t({ message: "Package" });
    },
  },
  {
    emoji: "📚",
    get label() {
      return t({ message: "Books" });
    },
  },
  {
    emoji: "🧪",
    get label() {
      return t({ message: "Test tube" });
    },
  },
  {
    emoji: "🔒",
    get label() {
      return t({ message: "Lock" });
    },
  },
  {
    emoji: "🎮",
    get label() {
      return t({ message: "Game" });
    },
  },
  {
    emoji: "🎵",
    get label() {
      return t({ message: "Music" });
    },
  },
  {
    emoji: "🎬",
    get label() {
      return t({ message: "Movie" });
    },
  },
  {
    emoji: "🖼️",
    get label() {
      return t({ message: "Picture" });
    },
  },
  {
    emoji: "🛍️",
    get label() {
      return t({ message: "Shopping" });
    },
  },
  {
    emoji: "🔥",
    get label() {
      return t({ message: "Fire" });
    },
  },
  {
    emoji: "💡",
    get label() {
      return t({ message: "Idea" });
    },
  },
  {
    emoji: "🧩",
    get label() {
      return t({ message: "Puzzle" });
    },
  },
  {
    emoji: "📊",
    get label() {
      return t({ message: "Chart" });
    },
  },
  {
    emoji: "🧠",
    get label() {
      return t({ message: "Brain" });
    },
  },
  {
    emoji: "🦄",
    get label() {
      return t({ message: "Unicorn" });
    },
  },
  {
    emoji: "🐙",
    get label() {
      return t({ message: "Octopus" });
    },
  },
  {
    emoji: "🌱",
    get label() {
      return t({ message: "Seedling" });
    },
  },
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
