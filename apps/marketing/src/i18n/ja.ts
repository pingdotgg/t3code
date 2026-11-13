import type { Messages } from "./en";

export const ja: Messages = {
  layout: {
    defaultTitle: "T3 Code",
    defaultDescription:
      "T3 Code。コーディングエージェントのためのオープンソースのコントロールプレーン。",
    socialImageAlt:
      "T3 Code：コーディングエージェントのためのオープンソースのコントロールプレーン。Claude Code、Codex、Cursor、OpenCode、Grok、Antigravity に対応。",
    homeLabel: "T3 Code ホーム",
    download: "ダウンロード",
    features: "機能",
    starsLabel: "GitHub で T3 Code にスターを付ける（{stars} スター）",
    language: "言語",
    terms: "利用規約",
    privacy: "プライバシー",
    security: "セキュリティ",
  },
  home: {
    title: "T3 Code | コーディングエージェントのためのオープンソースのコントロールプレーン",
    description: "T3 Code。コーディングエージェントのためのオープンソースのコントロールプレーン。",
    headline: "史上最高のエージェントアプリ。",
    subline:
      "すべてのコーディングエージェントを、落ち着いたひとつのアプリで。いま払っているサブスクのままで使えます。",
    installLabel: "インストール",
    channelLabel: "リリースチャンネル",
    stable: "安定版",
    nightly: "nightly",
    terminal: "ターミナル",
    downloadForMac: "macOS 版をダウンロード",
    downloadForWindows: "Windows 版をダウンロード",
    downloadForLinux: "Linux 版をダウンロード",
    downloadAction: "ダウンロード",
    copyAction: "コピー",
    copied: "コピーしました",
    alsoOn: "こちらにも対応",
    voicesLabel: "みんなの声",
    endorsementsTitle: "{users} 人以上の開発者が我慢して使っています",
    readPost: "X で {handle} の投稿を読む",
    showMore: "もっと見る",
    faqLabel: "よくある質問",
    faqs: [
      {
        question: "T3 Code の料金は？",
        answer:
          "無料です。T3 Code は MIT ライセンスのオープンソースです。プロバイダーへの支払いはこれまでどおりで、T3 Connect は 3 台まで無料で使えます。",
      },
      {
        question: "Claude Code や ChatGPT のサブスクは使えますか？",
        answer:
          "はい。T3 Code は、いま払っているプランのまま Claude Code、Codex、Cursor、Grok Build、OpenCode、Antigravity、Pi、Muse Code を動かします。",
      },
      {
        question: "サブスクを使うと BAN されませんか？",
        answer:
          "いいえ。T3 Code は Claude Code、Codex、Google Antigravity の利用規約の範囲内で動作します。Grok Build と Cursor の連携は各チームと協力して作りました。",
      },
      {
        question: "T3 Code はハーネスですか？",
        answer:
          "いいえ。Claude Code や Codex のようなハーネスは、モデルをエージェントにするものです。T3 Code はそれらを動かすアプリなので、作業のしかたを変えずに切り替えられます。",
      },
      {
        question: "コードは T3 のサーバーに送られますか？",
        answer:
          "いいえ。コードとプロンプトは、あなたのマシンからプロバイダーへ直接送られます。T3 Code が送るのは基本的な利用イベントだけで、プロンプトやファイルの内容は含まれません。オフにすることもできます。",
      },
      {
        question: "スマホや別のパソコンから使えますか？",
        answer:
          "はい。エージェントは T3 Code を入れたマシンで動きます。iOS・Android アプリや app.t3.codes から、T3 Connect、Tailscale、ローカルネットワーク経由で接続できます。",
      },
      {
        question: "Windows、Mac、Linux で動きますか？",
        answer: "はい、3 つすべてで動きます。デスクトップアプリでも t3 コマンドでも使えます。",
      },
    ],
  },
  features: {
    title: "機能 | T3 Code",
    description:
      "T3 Code でできること：リモート操作、ひとつのスレッドですべてのエージェント、手持ちのサブスク、MIT ライセンスのコードベース。",
    items: {
      anywhere: {
        title: "どこからでもマシンを操作",
        body: "エージェントは自宅で動き続けます。ブラウザやスマホから指示できます。",
      },
      machines: {
        title: "ほかのマシンも操作",
        body: "Mac mini、Linux マシン、VPS をつないで、ひとつのアプリからすべてでエージェントを動かせます。",
      },
      agents: {
        title: "すべてのエージェントを、ひとつのスレッドで",
        body: "好きなときにエージェントを切り替えられます。",
      },
      subscriptions: {
        title: "サブスクは持ち込みで",
        body: "いま払っているプランでサインインできます。",
      },
      open: {
        title: "芯までオープン",
        body: "すべてのコードが GitHub にあります。フォークしてください。",
      },
    },
  },
  download: {
    title: "T3 Code をダウンロード（macOS、Windows、Linux）| T3 Code",
    description:
      "公式の T3 Code デスクトップアプリ（macOS、Windows、Linux）や、iOS・Android アプリをダウンロードできます。公式のダウンロードサイトは t3.codes だけです。",
    breadcrumb: "ダウンロード",
    heading: "T3 Code をダウンロード",
    channelLabel: "リリースチャンネル",
    stable: "安定版",
    nightly: "Nightly",
    intelNote: "Intel Mac をお使いですか？　{link}。",
    intelLink: "x64 版をダウンロード",
    armNote: "ARM をお使いですか？　arm64 版の {deb} または {appimage} をダウンロード。",
    mobile: "モバイル",
    iphoneIpad: "iPhone と iPad",
    allBuilds: "すべてのビルドは {link} にあります",
    releasesPage: "GitHub のリリースページ",
    builtAgo: "{age}にビルド",
    releasesFallback: "リリース",
  },
};
