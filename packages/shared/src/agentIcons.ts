import type { McpGatewayProfile } from "@t3tools/contracts";

export type AgentLegacyIcon = NonNullable<McpGatewayProfile["icon"]>;

export type AgentIconCategory =
  | "general"
  | "dev"
  | "product"
  | "research"
  | "social"
  | "ops"
  | "art";

export const AGENT_ICON_CATEGORY_LABELS: Record<AgentIconCategory, string> = {
  general: "General",
  dev: "Dev",
  product: "Product",
  research: "Research",
  social: "Social",
  ops: "Ops",
  art: "Art",
};

export interface AgentIconEntry {
  readonly label: string;
  readonly category: AgentIconCategory;
  /** What older builds draw: they only know the `icon` literals. */
  readonly legacy: AgentLegacyIcon;
  readonly keywords: readonly string[];
}

/**
 * Curated agent icons, keyed by the stable id persisted in `iconId`. Every
 * legacy `icon` literal is also an id here, so legacy values resolve directly.
 * Web draws these with Lucide and mobile with Tabler; both maps are checked
 * against this catalog. The server reads `legacy` to fill `icon` for older builds.
 */
export const AGENT_ICONS = {
  orb: {
    label: "Orb",
    category: "general",
    legacy: "orb",
    keywords: ["circle", "sphere", "default"],
  },
  bot: {
    label: "Robot",
    category: "general",
    legacy: "bot",
    keywords: ["ai", "assistant", "agent"],
  },
  sparkles: {
    label: "Sparkles",
    category: "general",
    legacy: "sparkles",
    keywords: ["magic", "ai", "new"],
  },
  zap: {
    label: "Lightning",
    category: "general",
    legacy: "sparkles",
    keywords: ["fast", "bolt", "energy"],
  },
  star: {
    label: "Star",
    category: "general",
    legacy: "sparkles",
    keywords: ["favorite", "highlight"],
  },
  coffee: {
    label: "Coffee",
    category: "general",
    legacy: "orb",
    keywords: ["break", "helper", "daily"],
  },
  code: {
    label: "Code",
    category: "dev",
    legacy: "code",
    keywords: ["programming", "developer", "engineer"],
  },
  terminal: {
    label: "Terminal",
    category: "dev",
    legacy: "terminal",
    keywords: ["shell", "cli", "command"],
  },
  braces: { label: "Braces", category: "dev", legacy: "code", keywords: ["json", "api", "syntax"] },
  "git-branch": {
    label: "Branch",
    category: "dev",
    legacy: "code",
    keywords: ["git", "version control"],
  },
  "git-pull-request": {
    label: "Pull request",
    category: "dev",
    legacy: "code",
    keywords: ["git", "review", "pr", "merge"],
  },
  bug: {
    label: "Bug",
    category: "dev",
    legacy: "shield",
    keywords: ["debug", "fix", "issue", "qa"],
  },
  "test-tube": {
    label: "Test",
    category: "dev",
    legacy: "code",
    keywords: ["testing", "qa", "experiment"],
  },
  database: {
    label: "Database",
    category: "dev",
    legacy: "terminal",
    keywords: ["data", "sql", "storage"],
  },
  cpu: {
    label: "Chip",
    category: "dev",
    legacy: "terminal",
    keywords: ["hardware", "processor", "performance"],
  },
  package: {
    label: "Package",
    category: "dev",
    legacy: "code",
    keywords: ["dependency", "release", "box", "build"],
  },
  puzzle: {
    label: "Puzzle",
    category: "dev",
    legacy: "code",
    keywords: ["plugin", "integration", "extension"],
  },
  wrench: {
    label: "Wrench",
    category: "dev",
    legacy: "terminal",
    keywords: ["tool", "fix", "maintenance", "refactor"],
  },
  rocket: {
    label: "Rocket",
    category: "product",
    legacy: "sparkles",
    keywords: ["launch", "ship", "release"],
  },
  target: {
    label: "Target",
    category: "product",
    legacy: "sparkles",
    keywords: ["goal", "focus", "okr"],
  },
  lightbulb: {
    label: "Idea",
    category: "product",
    legacy: "sparkles",
    keywords: ["lightbulb", "brainstorm", "insight"],
  },
  "layout-dashboard": {
    label: "Dashboard",
    category: "product",
    legacy: "sparkles",
    keywords: ["layout", "ui", "overview"],
  },
  "clipboard-list": {
    label: "Checklist",
    category: "product",
    legacy: "pen",
    keywords: ["tasks", "plan", "todo", "spec"],
  },
  flag: {
    label: "Flag",
    category: "product",
    legacy: "sparkles",
    keywords: ["milestone", "feature flag", "priority"],
  },
  map: {
    label: "Map",
    category: "product",
    legacy: "search",
    keywords: ["roadmap", "plan", "journey"],
  },
  compass: {
    label: "Compass",
    category: "product",
    legacy: "search",
    keywords: ["direction", "strategy", "navigate"],
  },
  "trending-up": {
    label: "Growth",
    category: "product",
    legacy: "sparkles",
    keywords: ["metrics", "analytics", "trend"],
  },
  search: {
    label: "Search",
    category: "research",
    legacy: "search",
    keywords: ["find", "lookup", "investigate"],
  },
  "book-open": {
    label: "Book",
    category: "research",
    legacy: "search",
    keywords: ["docs", "reading", "learn"],
  },
  "graduation-cap": {
    label: "Scholar",
    category: "research",
    legacy: "search",
    keywords: ["education", "study", "academic", "teacher"],
  },
  microscope: {
    label: "Microscope",
    category: "research",
    legacy: "search",
    keywords: ["science", "analysis", "detail"],
  },
  flask: {
    label: "Flask",
    category: "research",
    legacy: "search",
    keywords: ["lab", "experiment", "chemistry"],
  },
  brain: {
    label: "Brain",
    category: "research",
    legacy: "sparkles",
    keywords: ["think", "reasoning", "mind"],
  },
  globe: {
    label: "Globe",
    category: "research",
    legacy: "search",
    keywords: ["web", "world", "internet", "browse"],
  },
  "chart-column": {
    label: "Chart",
    category: "research",
    legacy: "search",
    keywords: ["data", "analytics", "stats", "graph"],
  },
  "file-text": {
    label: "Document",
    category: "research",
    legacy: "pen",
    keywords: ["report", "notes", "summary"],
  },
  telescope: {
    label: "Telescope",
    category: "research",
    legacy: "search",
    keywords: ["explore", "discover", "scout"],
  },
  "message-circle": {
    label: "Chat",
    category: "social",
    legacy: "pen",
    keywords: ["message", "conversation", "support"],
  },
  megaphone: {
    label: "Megaphone",
    category: "social",
    legacy: "pen",
    keywords: ["marketing", "announce", "promo"],
  },
  users: {
    label: "People",
    category: "social",
    legacy: "bot",
    keywords: ["team", "community", "users"],
  },
  heart: {
    label: "Heart",
    category: "social",
    legacy: "sparkles",
    keywords: ["love", "care", "wellbeing"],
  },
  mail: {
    label: "Mail",
    category: "social",
    legacy: "pen",
    keywords: ["email", "inbox", "newsletter"],
  },
  "at-sign": {
    label: "Mention",
    category: "social",
    legacy: "pen",
    keywords: ["at", "handle", "twitter", "x"],
  },
  share: {
    label: "Share",
    category: "social",
    legacy: "sparkles",
    keywords: ["post", "publish", "network"],
  },
  hash: {
    label: "Hashtag",
    category: "social",
    legacy: "pen",
    keywords: ["tag", "channel", "topic"],
  },
  shield: {
    label: "Shield",
    category: "ops",
    legacy: "shield",
    keywords: ["security", "protect", "audit"],
  },
  lock: {
    label: "Lock",
    category: "ops",
    legacy: "shield",
    keywords: ["security", "secrets", "auth", "privacy"],
  },
  server: {
    label: "Server",
    category: "ops",
    legacy: "terminal",
    keywords: ["infra", "hosting", "backend"],
  },
  cloud: {
    label: "Cloud",
    category: "ops",
    legacy: "terminal",
    keywords: ["deploy", "aws", "infra"],
  },
  activity: {
    label: "Activity",
    category: "ops",
    legacy: "shield",
    keywords: ["monitoring", "health", "pulse", "uptime"],
  },
  gauge: {
    label: "Gauge",
    category: "ops",
    legacy: "terminal",
    keywords: ["performance", "speed", "metrics"],
  },
  calendar: {
    label: "Calendar",
    category: "ops",
    legacy: "pen",
    keywords: ["schedule", "planning", "date"],
  },
  bell: {
    label: "Bell",
    category: "ops",
    legacy: "shield",
    keywords: ["alert", "notification", "on-call", "pager"],
  },
  settings: {
    label: "Gear",
    category: "ops",
    legacy: "terminal",
    keywords: ["settings", "config", "automation"],
  },
  "life-buoy": {
    label: "Lifebuoy",
    category: "ops",
    legacy: "shield",
    keywords: ["support", "help", "incident", "rescue"],
  },
  pen: {
    label: "Pen",
    category: "art",
    legacy: "pen",
    keywords: ["write", "writer", "copy", "edit"],
  },
  palette: {
    label: "Palette",
    category: "art",
    legacy: "pen",
    keywords: ["design", "color", "paint"],
  },
  brush: {
    label: "Brush",
    category: "art",
    legacy: "pen",
    keywords: ["paint", "illustration", "draw"],
  },
  "pen-tool": {
    label: "Vector",
    category: "art",
    legacy: "pen",
    keywords: ["design", "bezier", "figma", "logo"],
  },
  camera: {
    label: "Camera",
    category: "art",
    legacy: "pen",
    keywords: ["photo", "photography", "shoot"],
  },
  image: {
    label: "Image",
    category: "art",
    legacy: "pen",
    keywords: ["picture", "graphic", "visual"],
  },
  film: { label: "Film", category: "art", legacy: "pen", keywords: ["video", "movie", "edit"] },
  music: { label: "Music", category: "art", legacy: "pen", keywords: ["audio", "sound", "song"] },
  shapes: {
    label: "Shapes",
    category: "art",
    legacy: "pen",
    keywords: ["geometry", "layout", "design"],
  },
} as const satisfies Record<string, AgentIconEntry>;

export type AgentIconId = keyof typeof AGENT_ICONS;

export const AGENT_ICON_IDS = Object.keys(AGENT_ICONS) as AgentIconId[];

export function isAgentIconId(value: string | null | undefined): value is AgentIconId {
  return typeof value === "string" && Object.hasOwn(AGENT_ICONS, value);
}

/**
 * The legacy `icon` written beside `iconId`, so builds that only read `icon` draw something
 * close. An id from a newer build falls back to the orb.
 */
export function legacyAgentIcon(iconId: string): AgentLegacyIcon {
  return isAgentIconId(iconId) ? AGENT_ICONS[iconId].legacy : "orb";
}
