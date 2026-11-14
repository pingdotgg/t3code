// Source strings. Every other locale must provide the same shape (see `Messages`).
// `{name}` placeholders are filled at render time and must survive translation.
export const en = {
  layout: {
    defaultTitle: "T3 Code",
    defaultDescription: "T3 Code. The open-source control plane for coding agents.",
    socialImageAlt:
      "T3 Code: the open-source control plane for coding agents, with Claude Code, Codex, Cursor, OpenCode, Grok and Antigravity.",
    homeLabel: "T3 Code home",
    download: "Download",
    starsLabel: "Star T3 Code on GitHub, {stars} stars",
    githubStars: "{stars} GitHub stars",
    language: "Language",
    mitLicensed: "MIT licensed",
    iosApp: "iOS app",
    androidApp: "Android app",
    terms: "Terms",
    privacy: "Privacy",
    security: "Security",
  },
  home: {
    title: "T3 Code | The open-source control plane for coding agents",
    description: "T3 Code. The open-source control plane for coding agents.",
    heroTitle: ["The open-source", "control plane", "for coding agents."],
    heroSub:
      "Orchestrate Claude Code, Codex, Antigravity, OpenCode, Cursor, and Grok from one surface. Bring your own subscription. Fork the whole thing.",
    downloadForMac: "Download for macOS",
    downloadForWindows: "Download for Windows",
    downloadForLinux: "Download for Linux",
    sourceLink: "Steal our code (legally)",
    alsoOnPhone: "Also on your phone:",
    screenshotAlt: "T3 Code running Claude, Codex, Muse, and Gemini subagents in one thread",
    endorsementsTitle: "Tolerated by over {users} devs",
    endorsementsSub: "Some of them even tweeted about it.",
    endorsementsLabel: "Developer endorsements",
    readPost: "Read {handle}'s post on X",
    harnessTitle: "Bring your own sub",
    harnessBody:
      "T3 Code doesn't resell tokens. Plug in Claude Code, Codex, Antigravity, OpenCode, Cursor, or Grok with the credentials you already have. We orchestrate them, you keep your plan.",
    googleSignIn: "Google sign-in",
    harnessPoints: [
      "No keys resold. No quota caps.",
      "Switch models mid-thread.",
      "More harnesses shipping weekly.",
    ],
    gitVisualLabel:
      "Illustration of the T3 Code Git workflow: review a diff, commit and push changes, and open a pull request.",
    prReady: "Ready",
    prCommits: "3 commits",
    viewDiff: "View diff",
    openPullRequest: "Open pull request",
    commitPush: "Commit & push",
    gitTitle: "One button to commit, push, and make a PR.",
    gitBody:
      "Every agent thread writes to its own branch. When it's good, one button opens the PR on GitHub with a generated title, body and changelog. No terminal dance required.",
    gitPoints: [
      "Auto-generated PR titles & bodies",
      "Inline diff review before you push",
      "Draft PRs, stack PRs, amend PRs",
      "Works with your existing GitHub auth",
    ],
    openTitle: "If you don't like something, fork it.",
    openPoints: [
      { lead: "Change the UI.", rest: "Restyle every surface to match your taste." },
      { lead: "Add an agent.", rest: "Wire in your own tools, models, and flows." },
      { lead: "Ship your own build.", rest: "Self-host it or distribute it as your own." },
    ],
    stars: "{stars} stars",
    forkOnGithub: "Fork on GitHub",
    browseSource: "Browse source",
    ctaTitle: "Your agents deserve better than a terminal.",
    ctaSub:
      "T3 Code is free, open source and fast. Install it, plug in the harness you already pay for, and let your agents get to work.",
    otherPlatforms: "Other platforms",
  },
  download: {
    title: "Download T3 Code for macOS, Windows, and Linux | T3 Code",
    description:
      "Download the official T3 Code desktop app for macOS, Windows, or Linux, or get the iOS and Android apps. t3.codes is the only official download site.",
    breadcrumb: "Download",
    heading: "Download T3 Code",
    channelLabel: "Release channel",
    stable: "Stable",
    nightly: "Nightly",
    intelNote: "On an Intel Mac? {link}.",
    intelLink: "Download the x64 build",
    armNote: "On ARM? Download the arm64 {deb} or {appimage}.",
    mobile: "Mobile",
    iphoneIpad: "iPhone & iPad",
    terminal: "Terminal",
    tryOnce: "Or try it once without installing:",
    allBuilds: "All builds are on the {link}",
    releasesPage: "GitHub releases page",
    builtAgo: "Built {age}",
    releasesFallback: "Releases",
  },
};

type Widen<T> = T extends string
  ? string
  : T extends ReadonlyArray<infer Item>
    ? ReadonlyArray<Widen<Item>>
    : { readonly [Key in keyof T]: Widen<T[Key]> };

export type Messages = Widen<typeof en>;
