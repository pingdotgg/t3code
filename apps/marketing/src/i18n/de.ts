import type { Messages } from "./en";

export const de: Messages = {
  layout: {
    defaultTitle: "T3 Code",
    defaultDescription: "T3 Code. Die Open-Source-Steuerzentrale für Coding-Agents.",
    socialImageAlt:
      "T3 Code: die Open-Source-Steuerzentrale für Coding-Agents, mit Claude Code, Codex, Cursor, OpenCode, Grok und Antigravity.",
    homeLabel: "Startseite von T3 Code",
    download: "Download",
    features: "Funktionen",
    starsLabel: "T3 Code auf GitHub einen Stern geben, {stars} Sterne",
    language: "Sprache",
    terms: "Nutzungsbedingungen",
    privacy: "Datenschutz",
    security: "Sicherheit",
  },
  home: {
    title: "T3 Code | Die Open-Source-Steuerzentrale für Coding-Agents",
    description: "T3 Code. Die Open-Source-Steuerzentrale für Coding-Agents.",
    headline: "Die beste Agenten-App aller Zeiten.",
    subline: "Alle Coding-Agents in einer ruhigen App, mit den Abos, die du schon bezahlst.",
    installLabel: "Installieren",
    channelLabel: "Release-Kanal",
    stable: "stable",
    nightly: "nightly",
    terminal: "Terminal",
    downloadForMac: "Für macOS herunterladen",
    downloadForWindows: "Für Windows herunterladen",
    downloadForLinux: "Für Linux herunterladen",
    downloadAction: "herunterladen",
    copyAction: "kopieren",
    copied: "kopiert",
    alsoOn: "Auch für",
    voicesLabel: "Was die Leute sagen",
    endorsementsTitle: "Toleriert von über {users} Devs",
    readPost: "Beitrag von {handle} auf X lesen",
    showMore: "Mehr anzeigen",
    faqLabel: "FAQ",
    faqs: [
      {
        question: "Was kostet T3 Code?",
        answer:
          "Nichts. T3 Code ist kostenlos und Open Source unter der MIT-Lizenz. Du bezahlst deinen Anbieter wie bisher, und T3 Connect ist für bis zu 3 Maschinen kostenlos.",
      },
      {
        question: "Kann ich mein Claude-Code- oder ChatGPT-Abo nutzen?",
        answer:
          "Ja. T3 Code führt Claude Code, Codex, Cursor, Grok Build, OpenCode, Antigravity, Pi und Muse Code mit den Tarifen aus, die du schon bezahlst.",
      },
      {
        question: "Werde ich gesperrt, wenn ich mein Abo nutze?",
        answer:
          "Nein. T3 Code hält sich an die Bedingungen von Claude Code, Codex und Google Antigravity, und die Integrationen für Grok Build und Cursor sind gemeinsam mit deren Teams entstanden.",
      },
      {
        question: "Ist T3 Code ein Harness?",
        answer:
          "Nein. Harnesses wie Claude Code und Codex machen aus einem Modell einen Agenten. T3 Code ist die App, in der du sie ausführst, sodass du zwischen ihnen wechseln kannst, ohne deine Arbeitsweise zu ändern.",
      },
      {
        question: "Landet mein Code auf T3-Servern?",
        answer:
          "Nein. Dein Code und deine Prompts gehen von deiner Maschine direkt an deinen Anbieter. T3 Code sendet einfache Nutzungsereignisse, niemals Prompts oder Dateiinhalte, und du kannst das abschalten.",
      },
      {
        question: "Kann ich es vom Handy oder einem anderen Computer aus nutzen?",
        answer:
          "Ja. Deine Agents laufen auf der Maschine mit T3 Code. Verbinde dich über die iOS- oder Android-App oder über app.t3.codes, per T3 Connect, Tailscale oder dein lokales Netzwerk.",
      },
      {
        question: "Läuft es unter Windows, Mac und Linux?",
        answer: "Ja, auf allen dreien, als Desktop-App oder über den Befehl t3.",
      },
    ],
  },
  features: {
    title: "Funktionen | T3 Code",
    description:
      "Alles, was T3 Code kann: Fernsteuerung, alle Agents in einem Thread, deine eigenen Abos und eine MIT-lizenzierte Codebasis.",
    items: {
      anywhere: {
        title: "Steuere deine Maschine von überall",
        body: "Deine Agents laufen zu Hause weiter. Lenke sie per Browser oder Handy.",
      },
      machines: {
        title: "Steuere deine anderen Maschinen",
        body: "Verbinde einen Mac mini, eine Linux-Kiste oder einen VPS und lass auf allen Agents laufen, aus einer App.",
      },
      agents: {
        title: "Alle Agents, ein Thread",
        body: "Wechsle den Agent, wann immer du willst.",
      },
      subscriptions: {
        title: "Bring dein eigenes Abo mit",
        body: "Melde dich mit den Tarifen an, die du schon bezahlst.",
      },
      open: {
        title: "Offen bis in den Kern",
        body: "Jede Zeile liegt auf GitHub. Forke es.",
      },
    },
  },
  download: {
    title: "T3 Code für macOS, Windows und Linux herunterladen | T3 Code",
    description:
      "Lade die offizielle Desktop-App von T3 Code für macOS, Windows oder Linux herunter, oder hol dir die Apps für iOS und Android. t3.codes ist die einzige offizielle Download-Seite.",
    breadcrumb: "Download",
    heading: "T3 Code herunterladen",
    channelLabel: "Release-Kanal",
    stable: "Stable",
    nightly: "Nightly",
    intelNote: "Mac mit Intel-Chip? {link}.",
    intelLink: "Lade den x64-Build herunter",
    armNote: "Auf ARM? Lade das {deb} oder {appimage} für arm64 herunter.",
    mobile: "Mobil",
    iphoneIpad: "iPhone & iPad",
    allBuilds: "Alle Builds findest du auf der {link}",
    releasesPage: "GitHub-Releases-Seite",
    builtAgo: "Erstellt {age}",
    releasesFallback: "Releases",
  },
};
