import type { Messages } from "./en";

export const fr: Messages = {
  layout: {
    defaultTitle: "T3 Code",
    defaultDescription: "T3 Code. Le poste de pilotage open source pour agents de codage.",
    socialImageAlt:
      "T3 Code : le poste de pilotage open source pour agents de codage, avec Claude Code, Codex, Cursor, OpenCode, Grok et Antigravity.",
    homeLabel: "Accueil T3 Code",
    download: "Télécharger",
    features: "Fonctionnalités",
    starsLabel: "Mettre une étoile à T3 Code sur GitHub, {stars} étoiles",
    language: "Langue",
    terms: "Conditions",
    privacy: "Confidentialité",
    security: "Sécurité",
  },
  home: {
    title: "T3 Code | Le poste de pilotage open source pour agents de codage",
    description: "T3 Code. Le poste de pilotage open source pour agents de codage.",
    headline: "La meilleure app d'agents de tous les temps.",
    subline:
      "Tous les agents de codage dans une app sereine, avec les abonnements que vous payez déjà.",
    installLabel: "Installer",
    channelLabel: "Canal de publication",
    stable: "stable",
    nightly: "nightly",
    terminal: "Terminal",
    downloadForMac: "Télécharger pour macOS",
    downloadForWindows: "Télécharger pour Windows",
    downloadForLinux: "Télécharger pour Linux",
    downloadAction: "télécharger",
    copyAction: "copier",
    copied: "copié",
    alsoOn: "Aussi sur",
    voicesLabel: "Ce qu'on en dit",
    endorsementsTitle: "Toléré par plus de {users} devs",
    readPost: "Lire le post de {handle} sur X",
    showMore: "Afficher plus",
    faqLabel: "FAQ",
    faqs: [
      {
        question: "Combien coûte T3 Code ?",
        answer:
          "Rien. T3 Code est gratuit et open source sous licence MIT. Vous continuez à payer votre fournisseur comme avant, et T3 Connect est gratuit jusqu'à 3 machines.",
      },
      {
        question: "Puis-je utiliser mon abonnement Claude Code ou ChatGPT ?",
        answer:
          "Oui. T3 Code fait tourner Claude Code, Codex, Cursor, Grok Build, OpenCode, Antigravity, Pi et Muse Code avec les forfaits que vous payez déjà.",
      },
      {
        question: "Vais-je être banni si j'utilise mon abonnement ?",
        answer:
          "Non. T3 Code respecte les conditions de Claude Code, Codex et Google Antigravity, et les intégrations Grok Build et Cursor ont été conçues avec leurs équipes.",
      },
      {
        question: "T3 Code est-il un harness ?",
        answer:
          "Non. Les harness comme Claude Code et Codex transforment un modèle en agent. T3 Code est l'app dans laquelle vous les lancez, pour passer de l'un à l'autre sans changer votre façon de travailler.",
      },
      {
        question: "Mon code passe-t-il par les serveurs de T3 ?",
        answer:
          "Non. Votre code et vos prompts vont directement de votre machine à votre fournisseur. T3 Code envoie des événements d'usage basiques, jamais de prompts ni de contenu de fichiers, et vous pouvez les désactiver.",
      },
      {
        question: "Puis-je l'utiliser depuis mon téléphone ou un autre ordinateur ?",
        answer:
          "Oui. Vos agents tournent sur la machine où se trouve T3 Code. Connectez-vous depuis l'app iOS ou Android ou depuis app.t3.codes, via T3 Connect, Tailscale ou votre réseau local.",
      },
      {
        question: "Est-ce que ça marche sur Windows, Mac et Linux ?",
        answer: "Oui, sur les trois, en app de bureau ou avec la commande t3.",
      },
    ],
  },
  features: {
    title: "Fonctionnalités | T3 Code",
    description:
      "Tout ce que fait T3 Code : contrôle à distance, tous les agents dans un même fil, vos propres abonnements et un code sous licence MIT.",
    items: {
      anywhere: {
        title: "Pilotez votre machine d'où que vous soyez",
        body: "Vos agents continuent de tourner à la maison. Dirigez-les depuis un navigateur ou votre téléphone.",
      },
      machines: {
        title: "Contrôlez vos autres machines",
        body: "Reliez un Mac mini, une machine Linux ou un VPS et lancez des agents sur tous depuis une seule app.",
      },
      agents: {
        title: "Tous les agents, un seul fil",
        body: "Changez d'agent quand vous voulez.",
      },
      subscriptions: {
        title: "Apportez votre abonnement",
        body: "Connectez-vous avec les forfaits que vous payez déjà.",
      },
      open: {
        title: "Ouvert jusqu'au cœur",
        body: "Chaque ligne est sur GitHub. Forkez-le.",
      },
    },
  },
  download: {
    title: "Télécharger T3 Code pour macOS, Windows et Linux | T3 Code",
    description:
      "Téléchargez l'app de bureau officielle T3 Code pour macOS, Windows ou Linux, ou les apps iOS et Android. t3.codes est le seul site de téléchargement officiel.",
    breadcrumb: "Télécharger",
    heading: "Télécharger T3 Code",
    channelLabel: "Canal de publication",
    stable: "Stable",
    nightly: "Nightly",
    intelNote: "Sur un Mac Intel ? {link}.",
    intelLink: "Téléchargez la version x64",
    armNote: "Sur ARM ? Téléchargez le {deb} ou l'{appimage} arm64.",
    mobile: "Mobile",
    iphoneIpad: "iPhone et iPad",
    allBuilds: "Toutes les versions sont sur la {link}",
    releasesPage: "page des releases GitHub",
    builtAgo: "Compilé {age}",
    releasesFallback: "Versions",
  },
};
