import * as Schema from "effect/Schema";
import {
  ProjectMonogramText,
  type ProjectIconColor,
  type ProjectIconOverride,
} from "@t3tools/contracts";
import { lucideIconNames } from "./lib/lucideIconByName";
import { deriveProjectIdentity } from "./projectIdentity";
export { PROJECT_ICON_COLORS, projectIconColorClassName } from "./projectIconColors";

export const PROJECT_ICON_CATEGORIES: ReadonlyArray<{
  readonly label: string;
  readonly icons: ReadonlyArray<string>;
}> = [
  {
    label: "Work",
    icons: [
      "briefcase",
      "kanban",
      "list-todo",
      "clipboard-list",
      "calendar",
      "target",
      "flag",
      "trophy",
      "presentation",
      "chart-line",
      "chart-pie",
      "users",
      "message-square",
      "mail",
      "inbox",
      "megaphone",
      "handshake",
    ],
  },
  {
    label: "Code",
    icons: [
      "folder-code",
      "code-2",
      "terminal",
      "braces",
      "bug",
      "git-branch",
      "git-pull-request",
      "git-merge",
      "git-commit-horizontal",
      "server",
      "database",
      "cpu",
      "bot",
      "sparkles",
      "workflow",
      "blocks",
      "puzzle",
      "cloud-cog",
    ],
  },
  {
    label: "Files",
    icons: [
      "folder",
      "folder-open",
      "folder-git-2",
      "file",
      "file-text",
      "file-code",
      "files",
      "archive",
      "book-open",
      "notebook-pen",
      "bookmark",
      "image",
      "paperclip",
      "package",
    ],
  },
  {
    label: "Status",
    icons: [
      "circle-check",
      "circle-alert",
      "circle-dot",
      "clock",
      "hourglass",
      "timer",
      "eye",
      "shield-check",
      "lock",
      "flame",
      "zap",
      "star",
      "heart",
      "pin",
      "bell",
    ],
  },
  {
    label: "Objects",
    icons: [
      "rocket",
      "wrench",
      "cog",
      "lightbulb",
      "flask-conical",
      "key",
      "palette",
      "pen-tool",
      "camera",
      "music",
      "gamepad-2",
      "gift",
      "coffee",
      "shopping-bag",
      "brain",
    ],
  },
  {
    label: "Places",
    icons: [
      "globe-2",
      "cloud",
      "smartphone",
      "monitor",
      "layers-3",
      "house",
      "map",
      "compass",
      "plane",
      "leaf",
      "sun",
      "moon",
    ],
  },
];

const ICON_KEYWORDS: Readonly<Record<string, ReadonlyArray<string>>> = {
  agent: ["bot", "sparkles", "brain"],
  ai: ["bot", "sparkles", "brain"],
  api: ["server", "braces", "workflow"],
  chat: ["message-square", "mail", "inbox"],
  data: ["database", "chart-line", "chart-pie"],
  deploy: ["rocket", "cloud", "package"],
  design: ["palette", "pen-tool", "image"],
  docs: ["book-open", "file-text", "notebook-pen"],
  done: ["circle-check", "trophy", "flag"],
  idea: ["lightbulb", "sparkles"],
  mobile: ["smartphone"],
  personal: ["heart", "house", "coffee"],
  pr: ["git-pull-request", "git-merge"],
  "pull request": ["git-pull-request", "git-merge"],
  release: ["rocket", "package", "flag"],
  review: ["eye", "git-pull-request", "message-square"],
  security: ["shield-check", "lock", "key"],
  settings: ["cog", "wrench"],
  task: ["list-todo", "clipboard-list", "circle-check"],
  test: ["flask-conical", "bug", "circle-check"],
  urgent: ["flame", "zap", "circle-alert"],
  wait: ["hourglass", "clock", "timer"],
  web: ["globe-2", "monitor"],
  work: ["briefcase", "kanban", "list-todo"],
};

export const MAX_ICON_RESULTS = 120;

export function filterProjectIconNames(query: string): ReadonlyArray<string> {
  const tokens = query
    .trim()
    .toLowerCase()
    .split(/[\s-]+/)
    .filter(Boolean);
  if (tokens.length === 0) return PROJECT_ICON_CATEGORIES.flatMap((category) => category.icons);
  const phrase = tokens.join(" ");
  const exact = tokens.join("-");
  const keywordHits = Object.entries(ICON_KEYWORDS)
    .filter(([keyword]) => phrase.length > 1 && keyword.startsWith(phrase))
    .flatMap(([, names]) => names);
  const nameHits = lucideIconNames.filter((name) => tokens.every((token) => name.includes(token)));
  const rank = (name: string) => (name === exact ? 0 : name.startsWith(tokens[0] ?? "") ? 1 : 2);
  const ranked = nameHits.toSorted((a, b) => rank(a) - rank(b));
  const exactHits = ranked.filter((name) => name === exact);
  return [...new Set([...exactHits, ...keywordHits, ...ranked])].slice(0, MAX_ICON_RESULTS);
}

export const PROJECT_EMOJI_CATEGORIES: ReadonlyArray<{
  readonly label: string;
  readonly emojis: ReadonlyArray<{ readonly emoji: string; readonly label: string }>;
}> = [
  {
    label: "Work and tech",
    emojis: [
      { emoji: "💻", label: "Computer" },
      { emoji: "🖥️", label: "Desktop" },
      { emoji: "⌨️", label: "Keyboard" },
      { emoji: "📱", label: "Mobile" },
      { emoji: "🤖", label: "Robot" },
      { emoji: "🧠", label: "Brain" },
      { emoji: "⚙️", label: "Gear" },
      { emoji: "🛠️", label: "Tools" },
      { emoji: "🔧", label: "Wrench" },
      { emoji: "🧪", label: "Test tube" },
      { emoji: "🗄️", label: "Database" },
      { emoji: "☁️", label: "Cloud" },
      { emoji: "📦", label: "Package" },
      { emoji: "🔒", label: "Lock" },
      { emoji: "🔑", label: "Key" },
      { emoji: "🐛", label: "Bug" },
    ],
  },
  {
    label: "Status",
    emojis: [
      { emoji: "🚀", label: "Rocket" },
      { emoji: "✨", label: "Sparkles" },
      { emoji: "⚡", label: "Lightning" },
      { emoji: "🔥", label: "Fire" },
      { emoji: "💡", label: "Idea" },
      { emoji: "🎯", label: "Target" },
      { emoji: "✅", label: "Check" },
      { emoji: "⏳", label: "Hourglass" },
      { emoji: "📌", label: "Pin" },
      { emoji: "🚧", label: "Construction" },
      { emoji: "⭐", label: "Star" },
      { emoji: "🏁", label: "Finish flag" },
      { emoji: "📣", label: "Megaphone" },
      { emoji: "💬", label: "Speech bubble" },
      { emoji: "👀", label: "Eyes" },
      { emoji: "❤️", label: "Heart" },
    ],
  },
  {
    label: "Docs and data",
    emojis: [
      { emoji: "📚", label: "Books" },
      { emoji: "📝", label: "Memo" },
      { emoji: "📄", label: "Page" },
      { emoji: "📁", label: "Folder" },
      { emoji: "🗂️", label: "Dividers" },
      { emoji: "📊", label: "Bar chart" },
      { emoji: "📈", label: "Chart" },
      { emoji: "🗓️", label: "Calendar" },
      { emoji: "📎", label: "Paperclip" },
      { emoji: "🔖", label: "Bookmark" },
    ],
  },
  {
    label: "Fun and life",
    emojis: [
      { emoji: "🎮", label: "Game" },
      { emoji: "🎵", label: "Music" },
      { emoji: "🎬", label: "Movie" },
      { emoji: "🎨", label: "Palette" },
      { emoji: "📷", label: "Camera" },
      { emoji: "🛍️", label: "Shopping" },
      { emoji: "☕", label: "Coffee" },
      { emoji: "🍕", label: "Pizza" },
      { emoji: "🏠", label: "Home" },
      { emoji: "✈️", label: "Plane" },
      { emoji: "🌱", label: "Seedling" },
      { emoji: "🌍", label: "Globe" },
      { emoji: "🦄", label: "Unicorn" },
      { emoji: "🐙", label: "Octopus" },
      { emoji: "🐳", label: "Whale" },
      { emoji: "🦊", label: "Fox" },
    ],
  },
];

const MAX_EMOJI_LENGTH = 32;

export function firstEmoji(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(trimmed);
  const segment = segments[Symbol.iterator]().next().value?.segment;
  const isFlag = /^\p{Regional_Indicator}{2}$/u.test(segment ?? "");
  const isKeycap = /^[#*0-9]️?⃣$/u.test(segment ?? "");
  if (
    !segment ||
    segment.length > MAX_EMOJI_LENGTH ||
    (!/\p{Extended_Pictographic}/u.test(segment) && !isFlag && !isKeycap)
  ) {
    return null;
  }
  return segment;
}

const DEFAULT_ICON = "folder-code";
const isMonogramText = Schema.is(ProjectMonogramText);

export interface ProjectIconDraft {
  readonly mode: ProjectIconOverride["kind"];
  readonly iconName: string;
  readonly color: ProjectIconColor;
  readonly letters: string;
  readonly emoji: string;
}

export function initialProjectIconDraft(
  current: ProjectIconOverride | null,
  name: string,
): ProjectIconDraft {
  const automatic = deriveProjectIdentity(name);
  return {
    mode: current?.kind ?? "lucide",
    iconName: current?.kind === "lucide" ? current.name : DEFAULT_ICON,
    color: current && current.kind !== "emoji" ? current.color : automatic.color,
    letters: current?.kind === "monogram" ? current.text : automatic.monogram,
    emoji: current?.kind === "emoji" ? current.emoji : "💻",
  };
}

function normalizeMonogram(letters: string): string {
  return letters.normalize("NFKC").trim().toUpperCase();
}

/** Null when the monogram letters are not valid yet. */
export function projectIconFromDraft(draft: ProjectIconDraft): ProjectIconOverride | null {
  if (draft.mode === "lucide") return { kind: "lucide", name: draft.iconName, color: draft.color };
  if (draft.mode === "emoji") return { kind: "emoji", emoji: draft.emoji };
  const text = normalizeMonogram(draft.letters);
  return isMonogramText(text) ? { kind: "monogram", text, color: draft.color } : null;
}
