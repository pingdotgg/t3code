import type { Messages } from "./en";

export const zh: Messages = {
  layout: {
    defaultTitle: "T3 Code",
    defaultDescription: "T3 Code：面向编程智能体的开源控制中心。",
    socialImageAlt:
      "T3 Code：面向编程智能体的开源控制中心，支持 Claude Code、Codex、Cursor、OpenCode、Grok 和 Antigravity。",
    homeLabel: "T3 Code 首页",
    download: "下载",
    features: "功能",
    starsLabel: "在 GitHub 上为 T3 Code 加星标，已有 {stars} 个星标",
    language: "语言",
    terms: "条款",
    privacy: "隐私",
    security: "安全",
  },
  home: {
    title: "T3 Code | 面向编程智能体的开源控制中心",
    description: "T3 Code：面向编程智能体的开源控制中心。",
    headline: "史上最好的智能体应用。",
    subline: "所有编程智能体，尽在一个清爽的应用里，用你已经在付费的订阅。",
    installLabel: "安装",
    channelLabel: "发布通道",
    stable: "稳定版",
    nightly: "nightly 版",
    terminal: "终端",
    downloadForMac: "下载 macOS 版",
    downloadForWindows: "下载 Windows 版",
    downloadForLinux: "下载 Linux 版",
    downloadAction: "下载",
    copyAction: "复制",
    copied: "已复制",
    alsoOn: "也支持",
    voicesLabel: "大家怎么说",
    endorsementsTitle: "超过 {users} 名开发者表示还能忍",
    readPost: "在 X 上阅读 {handle} 的帖子",
    showMore: "显示更多",
    faqLabel: "常见问题",
    faqs: [
      {
        question: "T3 Code 多少钱？",
        answer:
          "不要钱。T3 Code 免费，并以 MIT 许可证开源。你照常向模型提供商付费，T3 Connect 最多可免费连接 3 台机器。",
      },
      {
        question: "可以用我的 Claude Code 或 ChatGPT 订阅吗？",
        answer:
          "可以。T3 Code 用你已经在付费的套餐运行 Claude Code、Codex、Cursor、Grok Build、OpenCode、Antigravity、Pi 和 Muse Code。",
      },
      {
        question: "用自己的订阅会被封号吗？",
        answer:
          "不会。T3 Code 符合 Claude Code、Codex 和 Google Antigravity 的服务条款，Grok Build 和 Cursor 的集成是与对方团队合作完成的。",
      },
      {
        question: "T3 Code 是一个 harness 吗？",
        answer:
          "不是。Claude Code、Codex 这样的 harness 把模型变成智能体。T3 Code 是运行它们的应用，你可以在它们之间切换，而不用改变工作方式。",
      },
      {
        question: "我的代码会经过 T3 的服务器吗？",
        answer:
          "不会。你的代码和提示词从你的机器直接发送给模型提供商。T3 Code 只发送基本的使用事件，从不包含提示词或文件内容，而且可以关闭。",
      },
      {
        question: "可以在手机或另一台电脑上使用吗？",
        answer:
          "可以。智能体运行在装有 T3 Code 的机器上。你可以通过 T3 Connect、Tailscale 或本地网络，从 iOS、Android 应用或 app.t3.codes 连接过去。",
      },
      {
        question: "支持 Windows、Mac 和 Linux 吗？",
        answer: "三个都支持，可以用桌面应用，也可以用 t3 命令。",
      },
    ],
  },
  features: {
    title: "功能 | T3 Code",
    description:
      "T3 Code 的全部功能：远程控制、所有智能体同处一个线程、自带订阅，以及 MIT 许可的代码库。",
    items: {
      anywhere: {
        title: "随时随地操控你的机器",
        body: "智能体在家里持续运行，你用浏览器或手机指挥它们。",
      },
      machines: {
        title: "控制你的其他机器",
        body: "连接 Mac mini、Linux 主机或 VPS，在一个应用里让它们都跑起智能体。",
      },
      agents: {
        title: "所有智能体，一个线程",
        body: "想换智能体，随时换。",
      },
      subscriptions: {
        title: "自带订阅",
        body: "用你已经在付费的套餐登录。",
      },
      open: {
        title: "彻底开源",
        body: "每一行都在 GitHub 上。尽管 fork。",
      },
    },
  },
  download: {
    title: "下载 T3 Code：macOS、Windows 和 Linux 版 | T3 Code",
    description:
      "下载 T3 Code 官方桌面应用（macOS、Windows 或 Linux），或获取 iOS 和 Android 应用。t3.codes 是唯一的官方下载网站。",
    breadcrumb: "下载",
    heading: "下载 T3 Code",
    channelLabel: "发布通道",
    stable: "稳定版",
    nightly: "Nightly 版",
    intelNote: "使用 Intel 芯片的 Mac？{link}。",
    intelLink: "下载 x64 版本",
    armNote: "ARM 架构？下载 arm64 版 {deb} 或 {appimage}。",
    mobile: "移动端",
    iphoneIpad: "iPhone 和 iPad",
    allBuilds: "所有版本都在 {link}上",
    releasesPage: "GitHub 发布页面",
    builtAgo: "{age}构建",
    releasesFallback: "发布页面",
  },
};
