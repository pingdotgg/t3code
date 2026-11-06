// The T3 Code library topology. This file is the contract between page content and navigation:
// every page in `src/content/library` must have an entry here, and every entry must have a page.
// `scripts/check-library.mjs` enforces both directions plus the internal-link rules.

export type ClusterId =
  | "start"
  | "providers"
  | "threads"
  | "remote"
  | "safety"
  | "workspace"
  | "customize"
  | "concepts"
  | "videos"
  | "open-source";

export interface LibraryCluster {
  readonly id: ClusterId;
  readonly title: string;
  readonly summary: string;
}

export interface LibraryEntry {
  readonly cluster: ClusterId;
  /** URL segment under `/learn/<cluster>/`. */
  readonly slug: string;
  readonly title: string;
  /** Slugs (`cluster/slug`) this page is related to. The relation renders in both directions. */
  readonly related: ReadonlyArray<string>;
}

export const CLUSTERS: ReadonlyArray<LibraryCluster> = [
  {
    id: "start",
    title: "Get started",
    summary: "Install T3 Code, confirm the build is official, and run your first thread.",
  },
  {
    id: "providers",
    title: "Coding agents",
    summary: "Connect Claude Code, Codex, Cursor, OpenCode, and the other agents T3 Code runs.",
  },
  {
    id: "threads",
    title: "Threads and messages",
    summary: "Run work as threads, attach context, and move work between agents.",
  },
  {
    id: "remote",
    title: "Remote and mobile",
    summary: "Reach your machines from anywhere and follow agents from your phone.",
  },
  {
    id: "safety",
    title: "Permissions and privacy",
    summary: "Decide what agents may do, what leaves your machine, and how teams set policy.",
  },
  {
    id: "workspace",
    title: "Git, terminal, and previews",
    summary: "Review diffs, ship pull requests, and see what agents build.",
  },
  {
    id: "customize",
    title: "Settings and customization",
    summary: "Tune themes, keys, project settings, and usage limits.",
  },
  {
    id: "concepts",
    title: "Ideas behind T3 Code",
    summary: "Why a control plane for coding agents exists and how to work with agents well.",
  },
  {
    id: "videos",
    title: "Theo on T3 Code",
    summary: "Theo's videos about T3 Code, summarized with chapters and links to each feature.",
  },
  {
    id: "open-source",
    title: "Open source",
    summary: "The MIT-licensed codebase, how it is built, and how to contribute.",
  },
];

const e = (
  cluster: ClusterId,
  slug: string,
  title: string,
  related: ReadonlyArray<string> = [],
): LibraryEntry => ({
  cluster,
  slug,
  title,
  related,
});

export const ENTRIES: ReadonlyArray<LibraryEntry> = [
  // start
  e("start", "what-is-t3-code", "What is T3 Code?", [
    "concepts/control-plane-for-coding-agents",
    "videos/its-finally-here",
    "open-source/mit-license",
  ]),
  e("start", "install-macos", "Install T3 Code on macOS", [
    "start/verify-official-download",
    "start/updating",
  ]),
  e("start", "install-windows", "Install T3 Code on Windows", [
    "start/verify-official-download",
    "start/updating",
  ]),
  e("start", "install-linux", "Install T3 Code on Linux", [
    "start/verify-official-download",
    "open-source/build-from-source",
  ]),
  e("start", "verify-official-download", "How to verify you have the official T3 Code", [
    "safety/security-and-privacy",
    "open-source/mit-license",
  ]),
  e("start", "welcome-wizard", "First run: the welcome wizard", [
    "providers/claude-code",
    "providers/codex",
  ]),
  e("start", "updating", "Update T3 Code", ["start/verify-official-download"]),
  e("start", "faq", "T3 Code FAQ", ["start/what-is-t3-code", "safety/product-usage-data"]),

  // providers
  e("providers", "claude-code", "Use Claude Code in T3 Code", [
    "concepts/use-your-claude-subscription",
    "videos/trust-me-on-this",
    "videos/if-you-have-a-claude-sub",
  ]),
  e("providers", "codex", "Use Codex in T3 Code", [
    "concepts/use-your-chatgpt-plan",
    "providers/claude-code",
  ]),
  e("providers", "cursor", "Use Cursor in T3 Code", ["concepts/claude-code-vs-codex-vs-cursor"]),
  e("providers", "opencode", "Use OpenCode in T3 Code", ["providers/acp-agents"]),
  e("providers", "grok", "Use Grok in T3 Code", ["providers/codex"]),
  e("providers", "antigravity", "Use Antigravity in T3 Code", ["providers/acp-agents"]),
  e("providers", "kiro", "Use Kiro in T3 Code", ["providers/acp-agents"]),
  e("providers", "pi", "Use Pi in T3 Code", ["providers/acp-agents"]),
  e("providers", "fx", "Use fx in T3 Code", ["providers/acp-agents"]),
  e("providers", "muse-code", "Use Muse Code in T3 Code", ["providers/acp-agents"]),
  e("providers", "acp-agents", "Connect any ACP agent", ["open-source/adding-a-provider"]),

  // threads
  e("threads", "working-with-threads", "Work with threads", [
    "remote/remote-access",
    "threads/triage",
  ]),
  e("threads", "messages-and-context", "Messages, files, and context", [
    "threads/prompt-links",
    "threads/question-attachments",
  ]),
  e("threads", "prompt-links", "Share prompts with prompt links", ["threads/working-with-threads"]),
  e("threads", "question-attachments", "Attach files when an agent asks a question", [
    "threads/messages-and-context",
  ]),
  e("threads", "portable-handoffs", "Hand work from one agent to another", [
    "concepts/run-agents-in-parallel",
    "providers/claude-code",
    "providers/codex",
  ]),
  e("threads", "thread-migration", "Bring threads from older T3 Code versions", ["start/updating"]),
  e("threads", "triage", "Triage an issue with an agent", ["workspace/source-control"]),
  e("threads", "activity-log", "Read the activity log", [
    "threads/working-with-threads",
    "safety/permission-modes",
  ]),

  // remote
  e("remote", "remote-access", "Remote access to your machines", [
    "remote/t3-connect-troubleshooting",
    "safety/background-service",
  ]),
  e("remote", "devices", "Run iOS Simulator and Android Emulator in T3 Code", [
    "remote/remote-access",
  ]),
  e("remote", "mobile-apps", "T3 Code on iPhone and Android", [
    "remote/mobile-notifications",
    "videos/agents-sucked-at-ui",
  ]),
  e("remote", "mobile-notifications", "Mobile notifications", ["remote/devices"]),
  e("remote", "guest-links", "Share a thread with guest links", ["threads/working-with-threads"]),
  e("remote", "t3-connect-troubleshooting", "Fix T3 Connect problems", ["remote/devices"]),

  // safety
  e("safety", "security-and-privacy", "Security and privacy in T3 Code", [
    "safety/product-usage-data",
    "safety/permission-modes",
  ]),
  e("safety", "permission-modes", "Permission modes", ["concepts/run-agents-in-parallel"]),
  e("safety", "managed-policy", "Managed policy for teams", [
    "safety/permission-modes",
    "customize/project-settings",
  ]),
  e("safety", "product-usage-data", "Product usage data and telemetry", [
    "open-source/mit-license",
  ]),
  e("safety", "background-service", "Run T3 Code in the background", ["remote/devices"]),
  e("safety", "outside-agents", "Let outside agents drive T3 Code", [
    "safety/permission-modes",
    "providers/acp-agents",
  ]),

  // workspace
  e("workspace", "source-control", "Source control and pull requests", [
    "concepts/run-agents-in-parallel",
    "threads/triage",
  ]),
  e("workspace", "terminal", "Terminal history", [
    "concepts/gui-vs-terminal",
    "videos/done-with-terminals",
  ]),
  e("workspace", "visual-replies", "Visual replies and HTML renders", [
    "videos/agents-sucked-at-ui",
  ]),
  e("workspace", "snapshots", "SnapShots", ["workspace/visual-replies"]),
  e("workspace", "browser-import", "Import browser sessions", ["workspace/default-browser"]),
  e("workspace", "default-browser", "Use T3 Code as your default browser", [
    "workspace/visual-replies",
  ]),

  // customize
  e("customize", "appearance", "Appearance and themes", ["customize/keybindings"]),
  e("customize", "keybindings", "Keybindings", [
    "customize/keyboard-focus",
    "videos/code-without-typing",
  ]),
  e("customize", "keyboard-focus", "Keyboard focus", ["customize/keybindings"]),
  e("customize", "project-settings", "Settings and project overrides", [
    "customize/t3-project-file",
    "safety/managed-policy",
  ]),
  e("customize", "t3-project-file", "The t3.json project file", ["open-source/build-from-source"]),
  e("customize", "usage-and-limits", "Usage and limits", [
    "concepts/use-your-claude-subscription",
    "concepts/use-your-chatgpt-plan",
  ]),

  // concepts
  e("concepts", "control-plane-for-coding-agents", "What a control plane for coding agents is", [
    "concepts/what-is-a-harness",
    "videos/my-last-video-about-harnesses",
  ]),
  e("concepts", "what-is-a-harness", "Harness, model, and control plane: what each one does", [
    "videos/my-last-video-about-harnesses",
    "videos/how-i-code-with-ai-changed",
  ]),
  e("concepts", "gui-vs-terminal", "Why run coding agents in an app instead of a terminal", [
    "videos/done-with-terminals",
    "videos/t3-code-broke-me",
  ]),
  e("concepts", "use-your-claude-subscription", "Use your Claude subscription in T3 Code", [
    "videos/trust-me-on-this",
    "videos/if-you-have-a-claude-sub",
  ]),
  e("concepts", "use-your-chatgpt-plan", "Use your ChatGPT plan with Codex in T3 Code", [
    "providers/codex",
  ]),
  e("concepts", "run-agents-in-parallel", "Run several coding agents in parallel", [
    "videos/using-ai-agents-wrong",
    "workspace/source-control",
  ]),
  e("concepts", "agents-md-and-skills", "AGENTS.md and skills for coding agents", [
    "videos/using-ai-agents-wrong",
  ]),
  e("concepts", "claude-code-vs-codex-vs-cursor", "Claude Code, Codex, and Cursor in one app", [
    "providers/claude-code",
    "providers/codex",
    "providers/cursor",
  ]),

  // videos
  e("videos", "its-finally-here", "It's finally here: the T3 Code alpha launch", [
    "start/install-macos",
    "open-source/mit-license",
  ]),
  e("videos", "t3-code-broke-me", "T3 Code broke me", ["concepts/gui-vs-terminal"]),
  e("videos", "my-last-video-about-harnesses", "My last video about AI harnesses", [
    "concepts/what-is-a-harness",
  ]),
  e("videos", "agents-sucked-at-ui", "Agents sucked at UI (until today)", [
    "workspace/visual-replies",
  ]),
  e("videos", "using-ai-agents-wrong", "You're using AI agents wrong", [
    "concepts/run-agents-in-parallel",
  ]),
  e("videos", "how-i-code-with-ai-changed", "How I code with AI changed a lot", [
    "concepts/control-plane-for-coding-agents",
  ]),
  e("videos", "trust-me-on-this", "I need you guys to trust me on this", [
    "concepts/use-your-claude-subscription",
  ]),
  e("videos", "code-without-typing", "How I code without typing", ["customize/keybindings"]),
  e("videos", "done-with-terminals", "I'm done with terminals", ["concepts/gui-vs-terminal"]),
  e("videos", "if-you-have-a-claude-sub", "If you have a Claude sub, watch this", [
    "concepts/use-your-claude-subscription",
  ]),

  // open-source
  e("open-source", "mit-license", "T3 Code is free and MIT licensed", [
    "open-source/contributing",
    "open-source/third-party-licenses",
  ]),
  e("open-source", "architecture", "How T3 Code works", [
    "open-source/adding-a-provider",
    "concepts/control-plane-for-coding-agents",
  ]),
  e("open-source", "build-from-source", "Build T3 Code from source", ["open-source/contributing"]),
  e("open-source", "contributing", "Contribute to T3 Code", ["open-source/architecture"]),
  e("open-source", "adding-a-provider", "How agent providers plug into T3 Code", [
    "providers/acp-agents",
  ]),
  e("open-source", "third-party-licenses", "Open source licenses in T3 Code", [
    "open-source/mit-license",
  ]),
];

export const entryKey = (entry: Pick<LibraryEntry, "cluster" | "slug">): string =>
  `${entry.cluster}/${entry.slug}`;
export const entryPath = (key: string): string => `/learn/${key}`;
export const clusterPath = (id: ClusterId): string => `/learn/${id}`;

const byKey = new Map(ENTRIES.map((entry) => [entryKey(entry), entry]));
export const getEntry = (key: string): LibraryEntry | undefined => byKey.get(key);
export const getCluster = (id: ClusterId): LibraryCluster =>
  CLUSTERS.find((cluster) => cluster.id === id)!;
export const entriesIn = (id: ClusterId): ReadonlyArray<LibraryEntry> =>
  ENTRIES.filter((entry) => entry.cluster === id);

// Related links are symmetric by construction: if A names B, B also shows A.
export const relatedTo = (key: string): ReadonlyArray<LibraryEntry> => {
  const own = byKey.get(key)?.related ?? [];
  const inbound = ENTRIES.filter((entry) => entry.related.includes(key)).map(entryKey);
  return [...new Set([...own, ...inbound])].filter((k) => k !== key).map((k) => byKey.get(k)!);
};
