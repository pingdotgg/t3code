import type { Messages } from "./en";

export const ru: Messages = {
  layout: {
    defaultTitle: "T3 Code",
    defaultDescription: "T3 Code. Открытый пульт управления ИИ-агентами для программирования.",
    socialImageAlt:
      "T3 Code: открытый пульт управления ИИ-агентами для программирования. Claude Code, Codex, Cursor, OpenCode, Grok и Antigravity.",
    homeLabel: "Главная страница T3 Code",
    download: "Скачать",
    features: "Возможности",
    starsLabel: "Поставить звезду T3 Code на GitHub, звёзд: {stars}",
    language: "Язык",
    terms: "Условия",
    privacy: "Конфиденциальность",
    security: "Безопасность",
  },
  home: {
    title: "T3 Code | Открытый пульт управления ИИ-агентами для программирования",
    description: "T3 Code. Открытый пульт управления ИИ-агентами для программирования.",
    headline: "Лучшее приложение для агентов.",
    subline:
      "Все ИИ-агенты для программирования в одном спокойном приложении, на подписках, за которые вы уже платите.",
    installLabel: "Установка",
    channelLabel: "Канал релизов",
    stable: "стабильный",
    nightly: "nightly",
    terminal: "Терминал",
    downloadForMac: "Скачать для macOS",
    downloadForWindows: "Скачать для Windows",
    downloadForLinux: "Скачать для Linux",
    downloadAction: "скачать",
    copyAction: "копировать",
    copied: "скопировано",
    alsoOn: "Также на",
    voicesLabel: "Что говорят люди",
    endorsementsTitle: "Нас терпят более {users} разработчиков",
    readPost: "Читать пост {handle} в X",
    showMore: "Показать ещё",
    faqLabel: "Частые вопросы",
    faqs: [
      {
        question: "Сколько стоит T3 Code?",
        answer:
          "Нисколько. T3 Code бесплатный и открытый, под лицензией MIT. Вы по-прежнему платите своему провайдеру, а T3 Connect бесплатен для 3 машин.",
      },
      {
        question: "Можно использовать подписку Claude Code или ChatGPT?",
        answer:
          "Да. T3 Code запускает Claude Code, Codex, Cursor, Grok Build, OpenCode, Antigravity, Pi и Muse Code на тарифах, за которые вы уже платите.",
      },
      {
        question: "Меня забанят за использование подписки?",
        answer:
          "Нет. T3 Code работает в рамках условий Claude Code, Codex и Google Antigravity, а интеграции с Grok Build и Cursor сделаны вместе с их командами.",
      },
      {
        question: "T3 Code это харнесс?",
        answer:
          "Нет. Харнессы вроде Claude Code и Codex превращают модель в агента. T3 Code это приложение, в котором вы их запускаете, поэтому можно переключаться между ними, не меняя привычный способ работы.",
      },
      {
        question: "Мой код попадает на серверы T3?",
        answer:
          "Нет. Код и промпты идут с вашей машины напрямую провайдеру. T3 Code отправляет базовые события использования, без промптов и содержимого файлов, и это можно отключить.",
      },
      {
        question: "Можно пользоваться с телефона или другого компьютера?",
        answer:
          "Да. Агенты работают на машине, где установлен T3 Code. Подключайтесь из приложения для iOS или Android либо через app.t3.codes, с помощью T3 Connect, Tailscale или локальной сети.",
      },
      {
        question: "Работает на Windows, Mac и Linux?",
        answer: "Да, на всех трёх: как настольное приложение или через команду t3.",
      },
    ],
  },
  features: {
    title: "Возможности | T3 Code",
    description:
      "Всё, что умеет T3 Code: удалённое управление, все агенты в одном треде, ваши собственные подписки и код под лицензией MIT.",
    items: {
      anywhere: {
        title: "Управляйте своей машиной откуда угодно",
        body: "Агенты продолжают работать дома. Направляйте их из браузера или с телефона.",
      },
      machines: {
        title: "Управляйте другими машинами",
        body: "Подключите Mac mini, Linux-машину или VPS и запускайте агентов на всех из одного приложения.",
      },
      agents: {
        title: "Все агенты в одном треде",
        body: "Меняйте агента, когда захотите.",
      },
      subscriptions: {
        title: "Со своей подпиской",
        body: "Войдите с тарифами, за которые уже платите.",
      },
      open: {
        title: "Открыт до основания",
        body: "Каждая строка лежит на GitHub. Сделайте форк.",
      },
    },
  },
  download: {
    title: "Скачать T3 Code для macOS, Windows и Linux | T3 Code",
    description:
      "Скачайте официальное десктопное приложение T3 Code для macOS, Windows или Linux либо приложения для iOS и Android. Единственный официальный сайт для загрузки: t3.codes.",
    breadcrumb: "Скачать",
    heading: "Скачать T3 Code",
    channelLabel: "Канал релизов",
    stable: "Стабильный",
    nightly: "Nightly",
    intelNote: "Mac на Intel? {link}.",
    intelLink: "Скачайте сборку x64",
    armNote: "На ARM? Скачайте {deb} или {appimage} для arm64.",
    mobile: "Телефон",
    iphoneIpad: "iPhone и iPad",
    allBuilds: "Все сборки на {link}",
    releasesPage: "странице релизов GitHub",
    builtAgo: "Собрано {age}",
    releasesFallback: "Релизы",
  },
};
