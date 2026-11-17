// Source strings. Every other locale must provide the same shape (see `Messages`).
// `{name}` placeholders are filled at render time and must survive translation.
import { APP_FULL_NAME, APP_NAME, APP_SLOGAN } from "@t3tools/shared/branding";

export const en = {
  layout: {
    defaultTitle: APP_NAME,
    defaultDescription: `${APP_NAME} (${APP_FULL_NAME}) is an open-source desktop app for coding agents. Bring your own Claude Code, Codex, Cursor, OpenCode, Grok, or Antigravity subscription. ${APP_SLOGAN}`,
    socialImageAlt: `${APP_NAME}: ${APP_SLOGAN} With Claude Code, Codex, Cursor, OpenCode, Grok and Antigravity.`,
    homeLabel: `${APP_NAME} home`,
    download: "Download",
    starsLabel: `Star ${APP_NAME} on GitHub, {stars} stars`,
    githubStars: "{stars} GitHub stars",
    language: "Language",
    mitLicensed: "MIT licensed",
  },
  home: {
    title: `${APP_NAME} | ${APP_SLOGAN}`,
    description: `${APP_NAME} (${APP_FULL_NAME}) is an open-source desktop app for coding agents. Bring your own Claude Code, Codex, Cursor, OpenCode, Grok, or Antigravity subscription. ${APP_SLOGAN}`,
    heroTitle: [APP_SLOGAN],
    heroSub:
      "An open-source desktop app for coding agents. Run Claude Code, Codex, Antigravity, OpenCode, Cursor, and Grok side by side with the subscriptions you already pay for.",
    downloadForMac: "Download for macOS",
    downloadForWindows: "Download for Windows",
    downloadForLinux: "Download for Linux",
    downloadForIos: "Download for iOS",
    downloadForAndroid: "Download for Android",
    sourceLink: "Steal our code (legally)",
    screenshotAlt: `${APP_NAME} running Claude, Codex, Muse, and Gemini subagents in one thread`,
    harnessTitle: "Bring your own sub",
    harnessBody: `${APP_NAME} doesn't resell tokens. Plug in Claude Code, Codex, Antigravity, OpenCode, Cursor, or Grok with the credentials you already have. We orchestrate them, you keep your plan.`,
    googleSignIn: "Google sign-in",
    harnessPoints: [
      "No keys resold. No quota caps.",
      "Switch models mid-thread.",
      "More harnesses shipping weekly.",
    ],
    gitVisualLabel: `Illustration of the ${APP_NAME} Git workflow: review a diff, commit and push changes, and open a pull request.`,
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
    ctaSub: `${APP_NAME} is free, open source and fast. Install it, plug in the harness you already pay for, and let your agents get to work.`,
    otherPlatforms: "Other platforms",
  },
  download: {
    title: `Download ${APP_NAME} for macOS, Windows, and Linux | ${APP_NAME}`,
    description: `Download the official ${APP_NAME} desktop app for macOS, Windows, or Linux.`,
    breadcrumb: "Download",
    heading: `Download ${APP_NAME}`,
    channelLabel: "Release channel",
    stable: "Stable",
    nightly: "Nightly",
    intelNote: "On an Intel Mac? {link}.",
    intelLink: "Download the x64 build",
    armNote: "On ARM? Download the arm64 {deb} or {appimage}.",
    terminal: "Terminal",
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
