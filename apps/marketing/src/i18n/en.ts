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
    features: "Features",
    starsLabel: "Star T3 Code on GitHub, {stars} stars",
    language: "Language",
    terms: "Terms",
    privacy: "Privacy",
    security: "Security",
  },
  home: {
    title: "T3 Code | The open-source control plane for coding agents",
    description: "T3 Code. The open-source control plane for coding agents.",
    headline: "The best agent app ever.",
    subline: "Every coding agent in one calm app, on the subscriptions you already pay for.",
    installLabel: "Install",
    channelLabel: "Release channel",
    stable: "stable",
    nightly: "nightly",
    terminal: "Terminal",
    downloadForMac: "Download for macOS",
    downloadForWindows: "Download for Windows",
    downloadForLinux: "Download for Linux",
    downloadAction: "download",
    copyAction: "copy",
    copied: "copied",
    alsoOn: "Also on",
    voicesLabel: "What people say",
    endorsementsTitle: "Tolerated by over {users} devs.",
    readPost: "Read {handle}'s post on X",
    showMore: "Show more",
    faqLabel: "FAQs",
    faqs: [
      {
        question: "How much does T3 Code cost?",
        answer:
          "Nothing. T3 Code is free and open source under the MIT license. You keep paying your provider like you already do, and T3 Connect is free for up to 3 machines.",
      },
      {
        question: "Can I use my Claude Code or ChatGPT subscription?",
        answer:
          "Yes. T3 Code runs Claude Code, Codex, Cursor, Grok Build, OpenCode, Antigravity, Pi and Muse Code on the plans you already pay for.",
      },
      {
        question: "Will I get banned for using my subscription?",
        answer:
          "No. T3 Code stays within the terms of Claude Code, Codex and Google Antigravity, and the Grok Build and Cursor integrations were built with their teams.",
      },
      {
        question: "Is T3 Code a harness?",
        answer:
          "No. Harnesses like Claude Code and Codex turn a model into an agent. T3 Code is the app you run them in, so you can switch between them without changing how you work.",
      },
      {
        question: "Does my code go to T3 servers?",
        answer:
          "No. Your code and prompts go from your machine straight to your provider. T3 Code sends basic usage events, never prompts or file contents, and you can turn those off.",
      },
      {
        question: "Can I use it from my phone or another computer?",
        answer:
          "Yes. Your agents run on the machine with T3 Code. Connect to it from the iOS or Android app or app.t3.codes, through T3 Connect, Tailscale or your local network.",
      },
      {
        question: "Does it work on Windows, Mac and Linux?",
        answer: "Yes, all three, as a desktop app or the t3 command.",
      },
    ],
  },
  features: {
    title: "Features | T3 Code",
    description:
      "Everything T3 Code does: remote control, every agent in one thread, your own subscriptions, and an MIT-licensed codebase.",
    items: {
      anywhere: {
        title: "Drive your machine from anywhere",
        body: "Your agents keep running at home. Steer them from a browser or your phone.",
      },
      machines: {
        title: "Control your other machines",
        body: "Link a Mac mini, a Linux box or a VPS and run agents on all of them from one app.",
      },
      agents: {
        title: "Every agent, one thread",
        body: "Pick a different agent whenever you want.",
      },
      subscriptions: {
        title: "Bring your own subscription",
        body: "Sign in with the plans you already pay for.",
      },
      open: {
        title: "Open to the core",
        body: "Every line is on GitHub. Fork it.",
      },
    },
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
