export const PROJECT_ICON_NAMES = [
  "ai",
  "book",
  "cloud",
  "database",
  "desktop",
  "game",
  "image",
  "mobile",
  "music",
  "package",
  "security",
  "server",
  "shopping",
  "terminal",
  "test",
  "video",
  "web",
  "code",
  "braces",
  "circuit",
  "folder-code",
  "layers",
] as const;

export type ProjectIconName = (typeof PROJECT_ICON_NAMES)[number];

export type ProjectIconSelection =
  | { readonly kind: "lucide"; readonly icon: ProjectIconName }
  | { readonly kind: "emoji"; readonly icon: ProjectIconName; readonly emoji: string };

interface ProjectIconClass {
  readonly icon: ProjectIconName;
  readonly terms: ReadonlyArray<string>;
}

const PROJECT_ICON_MODEL: ReadonlyArray<ProjectIconClass> = [
  { icon: "ai", terms: ["ai", "agent", "bot", "gpt", "llm", "ml", "model", "neural"] },
  {
    icon: "mobile",
    terms: ["android", "expo", "ios", "mobile", "native", "reactnative", "swift"],
  },
  {
    icon: "desktop",
    terms: ["desktop", "electron", "linux", "mac", "macos", "tauri", "windows"],
  },
  {
    icon: "book",
    terms: ["book", "docs", "documentation", "guide", "handbook", "manual", "wiki"],
  },
  {
    icon: "security",
    terms: ["auth", "identity", "oauth", "security", "sso", "vault"],
  },
  {
    icon: "database",
    terms: [
      "analytics",
      "data",
      "database",
      "db",
      "mongo",
      "mysql",
      "postgres",
      "redis",
      "sql",
      "storage",
    ],
  },
  {
    icon: "cloud",
    terms: [
      "aws",
      "azure",
      "cloud",
      "deploy",
      "devops",
      "docker",
      "gcp",
      "infra",
      "kubernetes",
      "terraform",
    ],
  },
  {
    icon: "server",
    terms: ["api", "backend", "gateway", "server", "service", "worker"],
  },
  {
    icon: "terminal",
    terms: ["automation", "bash", "cli", "command", "script", "shell", "terminal"],
  },
  {
    icon: "package",
    terms: ["component", "kit", "lib", "library", "package", "plugin", "sdk", "toolkit"],
  },
  {
    icon: "test",
    terms: ["benchmark", "e2e", "fixture", "spec", "test", "testing"],
  },
  {
    icon: "shopping",
    terms: ["cart", "commerce", "market", "shop", "store"],
  },
  { icon: "game", terms: ["game", "gaming", "play"] },
  { icon: "music", terms: ["audio", "music", "podcast", "radio", "sound"] },
  { icon: "video", terms: ["film", "movie", "stream", "video"] },
  { icon: "image", terms: ["camera", "gallery", "image", "photo", "picture"] },
  {
    icon: "web",
    terms: [
      "browser",
      "frontend",
      "nextjs",
      "react",
      "site",
      "svelte",
      "ui",
      "vue",
      "web",
      "website",
    ],
  },
];

const GENERIC_PROJECT_ICONS: ReadonlyArray<ProjectIconName> = [
  "code",
  "braces",
  "circuit",
  "folder-code",
  "layers",
];

const PROJECT_ICON_EMOJIS: Record<ProjectIconName, string> = {
  ai: "🤖",
  book: "📚",
  braces: "🧩",
  circuit: "⚡",
  cloud: "☁️",
  code: "💻",
  database: "🗄️",
  desktop: "🖥️",
  "folder-code": "🛠️",
  game: "🎮",
  image: "🖼️",
  layers: "✨",
  mobile: "📱",
  music: "🎵",
  package: "📦",
  security: "🔒",
  server: "⚙️",
  shopping: "🛍️",
  terminal: "⌨️",
  test: "🧪",
  video: "🎬",
  web: "🌐",
};

const projectIconCache = new Map<string, ProjectIconSelection>();

function projectNameTokens(value: string): ReadonlyArray<string> {
  return value
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z\d]+/)
    .filter(Boolean);
}

function termScore(token: string, term: string): number {
  if (token === term) return 3;
  if (term.length >= 4 && (token.startsWith(term) || token.endsWith(term))) return 1;
  return 0;
}

function stableIndex(value: string, length: number): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % length;
}

export function selectProjectIcon(
  projectName: string,
  workspaceRoot: string,
): ProjectIconSelection {
  const name = projectName.trim() || workspaceRoot.split(/[\\/]+/).findLast(Boolean) || "project";
  const cacheKey = name.toLowerCase();
  const cachedIcon = projectIconCache.get(cacheKey);
  if (cachedIcon) return cachedIcon;

  const tokens = projectNameTokens(name);
  let bestIcon: ProjectIconName | null = null;
  let bestScore = 0;

  for (const projectClass of PROJECT_ICON_MODEL) {
    let score = 0;
    for (const token of tokens) {
      let tokenScore = 0;
      for (const term of projectClass.terms) {
        tokenScore = Math.max(tokenScore, termScore(token, term));
      }
      score += tokenScore;
    }
    if (score > bestScore) {
      bestIcon = projectClass.icon;
      bestScore = score;
    }
  }

  const iconName =
    bestIcon ?? GENERIC_PROJECT_ICONS[stableIndex(cacheKey, GENERIC_PROJECT_ICONS.length)]!;
  const icon: ProjectIconSelection = {
    kind: "emoji",
    icon: iconName,
    emoji: PROJECT_ICON_EMOJIS[iconName],
  };
  projectIconCache.set(cacheKey, icon);
  return icon;
}
