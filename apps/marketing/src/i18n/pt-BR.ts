import type { Messages } from "./en";

export const ptBR: Messages = {
  layout: {
    defaultTitle: "T3 Code",
    defaultDescription: "T3 Code. O painel de controle open source para agentes de programação.",
    socialImageAlt:
      "T3 Code: o painel de controle open source para agentes de programação, com Claude Code, Codex, Cursor, OpenCode, Grok e Antigravity.",
    homeLabel: "Página inicial do T3 Code",
    download: "Baixar",
    features: "Recursos",
    starsLabel: "Dê uma estrela ao T3 Code no GitHub, {stars} estrelas",
    language: "Idioma",
    terms: "Termos",
    privacy: "Privacidade",
    security: "Segurança",
  },
  home: {
    title: "T3 Code | O painel de controle open source para agentes de programação",
    description: "T3 Code. O painel de controle open source para agentes de programação.",
    headline: "O melhor app de agentes de todos os tempos.",
    subline:
      "Todos os agentes de programação em um app tranquilo, com as assinaturas que você já paga.",
    installLabel: "Instalar",
    channelLabel: "Canal de versões",
    stable: "estável",
    nightly: "nightly",
    terminal: "Terminal",
    downloadForMac: "Baixar para macOS",
    downloadForWindows: "Baixar para Windows",
    downloadForLinux: "Baixar para Linux",
    downloadAction: "baixar",
    copyAction: "copiar",
    copied: "copiado",
    alsoOn: "Também no",
    voicesLabel: "O que estão dizendo",
    endorsementsTitle: "Tolerado por mais de {users} devs",
    readPost: "Ler o post de {handle} no X",
    showMore: "Mostrar mais",
    faqLabel: "Perguntas frequentes",
    faqs: [
      {
        question: "Quanto custa o T3 Code?",
        answer:
          "Nada. O T3 Code é gratuito e open source sob a licença MIT. Você continua pagando seu provedor como já faz, e o T3 Connect é gratuito para até 3 máquinas.",
      },
      {
        question: "Posso usar minha assinatura do Claude Code ou do ChatGPT?",
        answer:
          "Sim. O T3 Code roda Claude Code, Codex, Cursor, Grok Build, OpenCode, Antigravity, Pi e Muse Code nos planos que você já paga.",
      },
      {
        question: "Vou ser banido por usar minha assinatura?",
        answer:
          "Não. O T3 Code segue os termos do Claude Code, do Codex e do Google Antigravity, e as integrações com Grok Build e Cursor foram feitas junto com as equipes deles.",
      },
      {
        question: "O T3 Code é um harness?",
        answer:
          "Não. Harnesses como Claude Code e Codex transformam um modelo em um agente. O T3 Code é o app onde você roda esses harnesses, então dá para trocar entre eles sem mudar seu jeito de trabalhar.",
      },
      {
        question: "Meu código passa pelos servidores da T3?",
        answer:
          "Não. Seu código e seus prompts vão da sua máquina direto para o seu provedor. O T3 Code envia eventos básicos de uso, nunca prompts nem conteúdo de arquivos, e você pode desativar isso.",
      },
      {
        question: "Posso usar pelo celular ou por outro computador?",
        answer:
          "Sim. Seus agentes rodam na máquina que tem o T3 Code. Conecte-se pelo app de iOS ou Android ou por app.t3.codes, via T3 Connect, Tailscale ou sua rede local.",
      },
      {
        question: "Funciona no Windows, Mac e Linux?",
        answer: "Sim, nos três, como app de desktop ou pelo comando t3.",
      },
    ],
  },
  features: {
    title: "Recursos | T3 Code",
    description:
      "Tudo o que o T3 Code faz: controle remoto, todos os agentes em uma thread, suas próprias assinaturas e um código com licença MIT.",
    items: {
      anywhere: {
        title: "Controle sua máquina de qualquer lugar",
        body: "Seus agentes continuam rodando em casa. Comande tudo pelo navegador ou pelo celular.",
      },
      machines: {
        title: "Controle suas outras máquinas",
        body: "Vincule um Mac mini, uma máquina Linux ou um VPS e rode agentes em todos a partir de um só app.",
      },
      agents: {
        title: "Todos os agentes, uma thread",
        body: "Troque de agente quando quiser.",
      },
      subscriptions: {
        title: "Traga sua própria assinatura",
        body: "Entre com os planos que você já paga.",
      },
      open: {
        title: "Aberto até o núcleo",
        body: "Cada linha está no GitHub. Faça um fork.",
      },
    },
  },
  download: {
    title: "Baixe o T3 Code para macOS, Windows e Linux | T3 Code",
    description:
      "Baixe o app oficial de desktop do T3 Code para macOS, Windows ou Linux, ou os apps para iOS e Android. t3.codes é o único site oficial de download.",
    breadcrumb: "Baixar",
    heading: "Baixar o T3 Code",
    channelLabel: "Canal de versões",
    stable: "Estável",
    nightly: "Nightly",
    intelNote: "Tem um Mac com Intel? {link}.",
    intelLink: "Baixe a versão x64",
    armNote: "Usa ARM? Baixe o {deb} ou o {appimage} para arm64.",
    mobile: "Mobile",
    iphoneIpad: "iPhone e iPad",
    allBuilds: "Todas as versões estão na {link}",
    releasesPage: "página de releases do GitHub",
    builtAgo: "Compilado {age}",
    releasesFallback: "Versões",
  },
};
