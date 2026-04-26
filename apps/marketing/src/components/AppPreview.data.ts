export type PreviewThread = {
  id: string;
  title: string;
  project: string;
  age: string;
  branch: string;
  checkoutValue: string;
  access: string;
  composerText: string;
  status?: string;
  statusTone?: "working" | "completed";
};

export type PreviewTurn =
  | {
      type: "user" | "assistant";
      text: string;
    }
  | {
      type: "tool";
      title: string;
      calls: string[];
    };

export const previewThreads: PreviewThread[] = [
  {
    id: "marketing-site",
    title: "I need to create a marketing site for this app bef...",
    project: "t3code-1",
    age: "1m ago",
    status: "Working",
    statusTone: "working",
    branch: "t3code-1",
    checkoutValue: "main",
    access: "Full access",
    composerText: "",
  },
  {
    id: "mobile-thread",
    title: "I want a way to mo...",
    project: "t3code-1",
    age: "6m ago",
    status: "Working",
    statusTone: "working",
    branch: "t3code-1",
    checkoutValue: "main",
    access: "Auto-accept edits",
    composerText: "Continue the mobile layout pass and keep the same app shell spacing.",
  },
  {
    id: "hotkeys-thread",
    title: "I want to add a h...",
    project: "t3code-1",
    age: "8m ago",
    status: "Completed",
    statusTone: "completed",
    branch: "t3code-1",
    checkoutValue: "main",
    access: "Supervised",
    composerText: "Add the global hotkey wiring and keep the shortcut labels consistent.",
  },
  {
    id: "old-hotkeys",
    title: "I want to add a few hotkeys t...",
    project: "t3code-1",
    age: "13h ago",
    branch: "t3code-1",
    checkoutValue: "main",
    access: "Full access",
    composerText: "Review the old shortcut branch and extract anything still useful.",
  },
  {
    id: "round-modernize",
    title: "I want to moderniz...",
    project: "round",
    age: "9m ago",
    status: "Working",
    statusTone: "working",
    branch: "round",
    checkoutValue: "main",
    access: "Full access",
    composerText: "Modernize the UI without changing the route structure.",
  },
  {
    id: "lawn-hard",
    title: "How hard would ...",
    project: "lawn",
    age: "7m ago",
    status: "Completed",
    statusTone: "completed",
    branch: "lawn",
    checkoutValue: "main",
    access: "Supervised",
    composerText: "Estimate the implementation path and call out any hidden risks.",
  },
  {
    id: "lawn-security",
    title: "What potential security issu...",
    project: "lawn",
    age: "7m ago",
    branch: "lawn",
    checkoutValue: "main",
    access: "Full access",
    composerText: "Audit the auth path and summarize the risky edges.",
  },
  {
    id: "lawn-analyze",
    title: "Help me analyze this project",
    project: "lawn",
    age: "9m ago",
    branch: "lawn",
    checkoutValue: "main",
    access: "Full access",
    composerText: "Build a concise project map from the repo structure.",
  },
  {
    id: "shoo-secure",
    title: "Is this app secure,...",
    project: "shoo",
    age: "just now",
    status: "Working",
    statusTone: "working",
    branch: "shoo",
    checkoutValue: "main",
    access: "Full access",
    composerText: "Inspect the app security posture and list the highest-risk fixes first.",
  },
] satisfies PreviewThread[];

export const previewProjects = [
  {
    id: "t3code-1",
    title: "t3code-1",
    icon: "t3",
    threads: ["marketing-site", "mobile-thread", "hotkeys-thread", "old-hotkeys"],
  },
  {
    id: "round",
    title: "round",
    icon: "round",
    threads: ["round-modernize"],
  },
  {
    id: "lawn",
    title: "lawn",
    icon: "lawn",
    threads: ["lawn-hard", "lawn-security", "lawn-analyze"],
  },
  {
    id: "shoo",
    title: "shoo",
    icon: "folder",
    threads: ["shoo-secure"],
  },
] as const;

export const previewTurns: Record<string, PreviewTurn[]> = {
  "marketing-site": [
    {
      type: "user",
      text: "I need to create a marketing site for this app before launch. Keep it in this repo, use the existing brand assets, and don’t touch the app runtime.",
    },
    {
      type: "assistant",
      text: "The repo doesn’t have existing Vercel/marketing-site wiring, so I have room to add a purpose-built app instead of working around prior deployment config. I’m checking the monorepo task conventions next, then I’ll scaffold apps/site and build the first version in one pass.",
    },
    {
      type: "tool",
      title: "Tool calls (3)",
      calls: [
        "Command run complete  /bin/zsh -lc \"sed -n '1,220p' scripts/dev-runner.ts\"",
        "Command run complete  /bin/zsh -lc \"sed -n '1,220p' apps/desktop/package.json\"",
        "Command run complete  /bin/zsh -lc \"sed -n '1,240p' README.md\"",
      ],
    },
    {
      type: "assistant",
      text: "I’ve confirmed the new app can stand alone without touching the product runtime. I’m inspecting the existing brand assets now so the marketing site can reuse what you already have rather than inventing a disconnected visual identity.",
    },
    {
      type: "user",
      text: "Use the real screenshot space only. I do not want another explainer section or duplicated marketing copy around it.",
    },
    {
      type: "tool",
      title: "Tool calls (2)",
      calls: [
        "Image view complete  /Users/theo/Code/Work/t3code/clones/t3code-1/assets/T3 Code logo.svg",
        "Image view complete  /Users/theo/Code/Work/t3code/clones/t3code-1/assets/T3 Code-macOS-Default.png",
      ],
    },
    {
      type: "assistant",
      text: "I’m replacing only the screenshot slot. The preview keeps the same aspect ratio as the live asset and uses the current product shell as the source of truth.",
    },
    {
      type: "user",
      text: "Make the fake data feel like an active product session, not a single static exchange.",
    },
    {
      type: "tool",
      title: "Tool calls (3)",
      calls: [
        "Network complete  GET https://t3.codes/screenshot.jpeg",
        'Command run complete  identify -format "%wx%h" /tmp/t3-screenshot.jpeg',
        "Edit complete  apps/marketing/src/components/AppPreview.astro",
      ],
    },
    {
      type: "assistant",
      text: "The preview now has several active threads, project groups, tool-call cards, and follow-up prompts so clicking around feels like a real workspace instead of a flat mock.",
    },
  ],
  "mobile-thread": [
    { type: "user", text: "I want a way to move between active implementation threads faster." },
    {
      type: "assistant",
      text: "I’m tightening the sidebar interaction and checking the keyboard path before changing the command palette.",
    },
    {
      type: "tool",
      title: "Tool calls (2)",
      calls: [
        "Read complete  apps/web/src/components/CommandPalette.tsx",
        'Search complete  rg "activeThread|navigate" apps/web/src',
      ],
    },
    {
      type: "assistant",
      text: "The quickest path is keeping thread switching in the sidebar and making the command palette reuse the same thread labels, age text, and project grouping.",
    },
    {
      type: "user",
      text: "Can you make it work from keyboard too? I switch threads while the composer is focused most of the time.",
    },
    {
      type: "tool",
      title: "Tool calls (3)",
      calls: [
        'Search complete  rg "composerRef|focusComposer" apps/web/src/components',
        "Read complete  apps/web/src/components/ChatView.tsx",
        "Edit complete  apps/web/src/components/ThreadSidebar.tsx",
      ],
    },
    {
      type: "assistant",
      text: "Yes. I’m keeping the shortcut at the shell level and preserving composer focus after navigation so the next prompt can be typed immediately.",
    },
  ],
  "hotkeys-thread": [
    { type: "user", text: "I want to add a hotkey to jump back into the current thread." },
    {
      type: "assistant",
      text: "I’ll add the shortcut at the app shell boundary so it works from the editor, sidebar, and modal states without each feature reimplementing it.",
    },
    {
      type: "tool",
      title: "Tool calls (3)",
      calls: [
        'Search complete  rg "keydown|hotkey|shortcut" apps/web/src',
        "Edit complete  apps/web/src/hooks/useGlobalShortcuts.ts",
        "Command run complete  bun typecheck --filter @t3tools/web",
      ],
    },
    {
      type: "assistant",
      text: "Completed the shortcut registration and verified it does not collide with the existing search command.",
    },
    {
      type: "user",
      text: "Add the shortcut label anywhere the user can discover it, but do not make the sidebar noisier.",
    },
    {
      type: "tool",
      title: "Tool calls (2)",
      calls: [
        "Edit complete  apps/web/src/components/CommandPalette.tsx",
        "Command run complete  bun lint --filter @t3tools/web",
      ],
    },
    {
      type: "assistant",
      text: "Added discovery in the command palette and kept the sidebar unchanged. The shortcut remains available globally without adding another persistent badge.",
    },
  ],
  "old-hotkeys": [
    {
      type: "user",
      text: "I want to add a few hotkeys to make common navigation less mouse-heavy.",
    },
    {
      type: "assistant",
      text: "The older branch already has useful command names, but the event handling is too local. I’d keep the labels and move the listeners to the shell.",
    },
    {
      type: "tool",
      title: "Tool calls (2)",
      calls: [
        "Git diff inspected  shortcut-prototype",
        'Search complete  rg "Meta|ctrlKey" apps/web/src',
      ],
    },
    {
      type: "user",
      text: "If anything in that branch is stale, ignore it. I only care about the parts that still fit the current shell.",
    },
    {
      type: "assistant",
      text: "The stale pieces are tied to removed local state. The reusable part is the command naming and the fallback behavior when no thread is active.",
    },
    {
      type: "tool",
      title: "Tool calls (2)",
      calls: [
        "Read complete  apps/web/src/session-logic.ts",
        'Search complete  rg "activeThreadId" apps/web/src',
      ],
    },
  ],
  "round-modernize": [
    {
      type: "user",
      text: "I want to modernize the dashboard without making it feel like a separate product.",
    },
    {
      type: "assistant",
      text: "I’m mapping the existing surfaces first, then I’ll update the spacing and icon treatment in one contained pass.",
    },
    {
      type: "tool",
      title: "Tool calls (3)",
      calls: [
        "Read complete  app/routes/dashboard.tsx",
        "Read complete  app/components/project-list.tsx",
        "Screenshot captured  localhost:3000/dashboard",
      ],
    },
    {
      type: "assistant",
      text: "The main issue is density drift: the cards use three spacing systems. I’m consolidating them around the current table rhythm and leaving route behavior untouched.",
    },
    {
      type: "user",
      text: "Do the empty states too. Those are the parts that make the app feel the oldest.",
    },
    {
      type: "tool",
      title: "Tool calls (3)",
      calls: [
        "Read complete  app/components/empty-state.tsx",
        "Edit complete  app/routes/dashboard.tsx",
        "Screenshot captured  localhost:3000/dashboard?empty=1",
      ],
    },
    {
      type: "assistant",
      text: "Empty states now share the same spacing, border, and icon scale as the populated cards, so the page no longer changes visual systems when data is missing.",
    },
  ],
  "lawn-hard": [
    { type: "user", text: "How hard would it be to replace the current onboarding flow?" },
    {
      type: "assistant",
      text: "The main cost is state migration, not the UI. I’d isolate the new flow behind the existing account boundary first.",
    },
    {
      type: "tool",
      title: "Tool calls (2)",
      calls: [
        'Search complete  rg "onboarding|welcome|firstRun" .',
        "Read complete  src/server/account-state.ts",
      ],
    },
    {
      type: "assistant",
      text: "Estimate: one focused pass for the UI, a second pass for migration tests, and a short beta window because existing users can re-enter this path.",
    },
    {
      type: "user",
      text: "What is the riskiest migration edge?",
    },
    {
      type: "tool",
      title: "Tool calls (3)",
      calls: [
        "Read complete  src/server/user-profile.ts",
        'Search complete  rg "onboardingCompleted|firstSeen" src',
        "Command run complete  bun run test onboarding",
      ],
    },
    {
      type: "assistant",
      text: "Users with partially completed profiles are the risky edge. The migration should treat missing profile fields as resumable onboarding, not as a brand-new account.",
    },
  ],
  "lawn-security": [
    { type: "user", text: "What potential security issues should I fix before sharing this?" },
    {
      type: "assistant",
      text: "I’m checking auth boundaries, server-only secrets, file uploads, and any route that trusts client-provided IDs.",
    },
    {
      type: "tool",
      title: "Tool calls (4)",
      calls: [
        'Search complete  rg "process.env|PUBLIC_|SECRET" .',
        "Read complete  src/middleware.ts",
        "Read complete  src/routes/api/upload.ts",
        "Command run complete  bun typecheck",
      ],
    },
    {
      type: "assistant",
      text: "The highest-risk item is upload validation. Auth is centralized, but the file path accepts more MIME types than the UI advertises.",
    },
    {
      type: "user",
      text: "Can you rank the fixes by what blocks a beta versus what can wait?",
    },
    {
      type: "tool",
      title: "Tool calls (3)",
      calls: [
        "Read complete  src/routes/api/session.ts",
        "Read complete  src/lib/rate-limit.ts",
        'Search complete  rg "TODO|unsafe|any" src/routes src/server',
      ],
    },
    {
      type: "assistant",
      text: "Beta blockers: upload MIME validation, rate limiting on auth routes, and removing debug token output. Later: stricter CSP and audit logging polish.",
    },
  ],
  "lawn-analyze": [
    { type: "user", text: "Help me analyze this project and tell me where to start." },
    {
      type: "assistant",
      text: "I’m building a map of the app structure first, then I’ll separate product logic from styling-only debt.",
    },
    {
      type: "tool",
      title: "Tool calls (3)",
      calls: [
        "List complete  src",
        "Read complete  package.json",
        'Search complete  rg "TODO|FIXME|hack" src',
      ],
    },
    {
      type: "assistant",
      text: "Start with the data-loading layer. Most UI issues are downstream from duplicated loading state and inconsistent empty-state handling.",
    },
    {
      type: "user",
      text: "Give me the shortest path to a cleaner first PR.",
    },
    {
      type: "tool",
      title: "Tool calls (2)",
      calls: [
        'Search complete  rg "isLoading|loading" src',
        "Read complete  src/components/project-shell.tsx",
      ],
    },
    {
      type: "assistant",
      text: "First PR: centralize loading and empty-state presentation inside the project shell. It touches fewer routes and makes later UI cleanup much smaller.",
    },
  ],
  "shoo-secure": [
    { type: "user", text: "Is this app secure enough to put behind a public beta?" },
    {
      type: "assistant",
      text: "I’m checking auth boundaries, storage access, and server-only environment usage before making a recommendation.",
    },
    {
      type: "tool",
      title: "Tool calls (3)",
      calls: [
        "Read complete  src/App.tsx",
        "Read complete  src/index.css",
        'Search complete  rg "token|claims|localStorage|cookie" src',
      ],
    },
    {
      type: "assistant",
      text: "For a demo, yes. For beta, not yet: token display should be removed, refresh behavior needs a server validation path, and the callback route should document expected claims.",
    },
    {
      type: "user",
      text: "Patch the obvious token leak first and leave notes for the server validation work.",
    },
    {
      type: "tool",
      title: "Tool calls (3)",
      calls: [
        "Edit complete  src/App.tsx",
        "Edit complete  src/auth-notes.md",
        "Command run complete  bun typecheck",
      ],
    },
    {
      type: "assistant",
      text: "The visible token output is removed. I left the server validation notes next to the auth flow so the beta hardening work has a clear next step.",
    },
  ],
};
