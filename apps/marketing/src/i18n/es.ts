import type { Messages } from "./en";

export const es: Messages = {
  layout: {
    defaultTitle: "T3 Code",
    defaultDescription:
      "T3 Code. El panel de control de código abierto para agentes de programación.",
    socialImageAlt:
      "T3 Code: el panel de control de código abierto para agentes de programación, con Claude Code, Codex, Cursor, OpenCode, Grok y Antigravity.",
    homeLabel: "Inicio de T3 Code",
    download: "Descargar",
    features: "Funciones",
    starsLabel: "Dale una estrella a T3 Code en GitHub, {stars} estrellas",
    language: "Idioma",
    terms: "Términos",
    privacy: "Privacidad",
    security: "Seguridad",
  },
  home: {
    title: "T3 Code | El panel de control de código abierto para agentes de programación",
    description: "T3 Code. El panel de control de código abierto para agentes de programación.",
    headline: "La mejor app de agentes de la historia.",
    subline:
      "Todos los agentes de programación en una app tranquila, con las suscripciones que ya pagas.",
    installLabel: "Instalar",
    channelLabel: "Canal de versiones",
    stable: "estable",
    nightly: "nightly",
    terminal: "Terminal",
    downloadForMac: "Descargar para macOS",
    downloadForWindows: "Descargar para Windows",
    downloadForLinux: "Descargar para Linux",
    downloadAction: "descargar",
    copyAction: "copiar",
    copied: "copiado",
    alsoOn: "También en",
    voicesLabel: "Lo que dice la gente",
    endorsementsTitle: "Tolerado por más de {users} desarrolladores",
    readPost: "Leer la publicación de {handle} en X",
    showMore: "Ver más",
    faqLabel: "Preguntas frecuentes",
    faqs: [
      {
        question: "¿Cuánto cuesta T3 Code?",
        answer:
          "Nada. T3 Code es gratis y de código abierto bajo la licencia MIT. Sigues pagando a tu proveedor como hasta ahora, y T3 Connect es gratis para hasta 3 máquinas.",
      },
      {
        question: "¿Puedo usar mi suscripción de Claude Code o ChatGPT?",
        answer:
          "Sí. T3 Code ejecuta Claude Code, Codex, Cursor, Grok Build, OpenCode, Antigravity, Pi y Muse Code con los planes que ya pagas.",
      },
      {
        question: "¿Me van a banear por usar mi suscripción?",
        answer:
          "No. T3 Code cumple los términos de Claude Code, Codex y Google Antigravity, y las integraciones de Grok Build y Cursor se hicieron junto con sus equipos.",
      },
      {
        question: "¿T3 Code es un harness?",
        answer:
          "No. Los harnesses como Claude Code y Codex convierten un modelo en un agente. T3 Code es la app donde los ejecutas, así que puedes cambiar entre ellos sin cambiar tu forma de trabajar.",
      },
      {
        question: "¿Mi código pasa por los servidores de T3?",
        answer:
          "No. Tu código y tus prompts van de tu máquina directamente a tu proveedor. T3 Code envía eventos de uso básicos, nunca prompts ni contenido de archivos, y puedes desactivarlos.",
      },
      {
        question: "¿Puedo usarlo desde mi teléfono u otro ordenador?",
        answer:
          "Sí. Tus agentes se ejecutan en la máquina que tiene T3 Code. Conéctate desde la app de iOS o Android o desde app.t3.codes, mediante T3 Connect, Tailscale o tu red local.",
      },
      {
        question: "¿Funciona en Windows, Mac y Linux?",
        answer: "Sí, en los tres, como app de escritorio o con el comando t3.",
      },
    ],
  },
  features: {
    title: "Funciones | T3 Code",
    description:
      "Todo lo que hace T3 Code: control remoto, todos los agentes en un hilo, tus propias suscripciones y un código con licencia MIT.",
    items: {
      anywhere: {
        title: "Controla tu máquina desde cualquier lugar",
        body: "Tus agentes siguen ejecutándose en casa. Dirígelos desde un navegador o tu teléfono.",
      },
      machines: {
        title: "Controla tus otras máquinas",
        body: "Vincula un Mac mini, un equipo Linux o un VPS y ejecuta agentes en todos desde una sola app.",
      },
      agents: {
        title: "Todos los agentes, un solo hilo",
        body: "Cambia de agente cuando quieras.",
      },
      subscriptions: {
        title: "Trae tu propia suscripción",
        body: "Inicia sesión con los planes que ya pagas.",
      },
      open: {
        title: "Abierto hasta el núcleo",
        body: "Cada línea está en GitHub. Haz un fork.",
      },
    },
  },
  download: {
    title: "Descarga T3 Code para macOS, Windows y Linux | T3 Code",
    description:
      "Descarga la app oficial de escritorio de T3 Code para macOS, Windows o Linux, o consigue las apps para iOS y Android. t3.codes es el único sitio oficial de descarga.",
    breadcrumb: "Descargar",
    heading: "Descargar T3 Code",
    channelLabel: "Canal de versiones",
    stable: "Estable",
    nightly: "Nightly",
    intelNote: "¿Tienes un Mac con Intel? {link}.",
    intelLink: "Descarga la versión x64",
    armNote: "¿Usas ARM? Descarga el {deb} o el {appimage} para arm64.",
    mobile: "Móvil",
    iphoneIpad: "iPhone y iPad",
    allBuilds: "Todas las compilaciones están en la {link}",
    releasesPage: "página de versiones de GitHub",
    builtAgo: "Compilada {age}",
    releasesFallback: "Versiones",
  },
};
