import type { Messages } from "./en";

export const ko: Messages = {
  layout: {
    defaultTitle: "T3 Code",
    defaultDescription: "T3 Code. 코딩 에이전트를 위한 오픈 소스 컨트롤 플레인.",
    socialImageAlt:
      "T3 Code: 코딩 에이전트를 위한 오픈 소스 컨트롤 플레인. Claude Code, Codex, Cursor, OpenCode, Grok, Antigravity 지원.",
    homeLabel: "T3 Code 홈",
    download: "다운로드",
    features: "기능",
    starsLabel: "GitHub에서 T3 Code에 스타 주기, 현재 스타 {stars}",
    language: "언어",
    terms: "이용약관",
    privacy: "개인정보처리방침",
    security: "보안",
  },
  home: {
    title: "T3 Code | 코딩 에이전트를 위한 오픈 소스 컨트롤 플레인",
    description: "T3 Code. 코딩 에이전트를 위한 오픈 소스 컨트롤 플레인.",
    headline: "역대 최고의 에이전트 앱.",
    subline: "모든 코딩 에이전트를 차분한 앱 하나에서, 이미 결제 중인 구독 그대로.",
    installLabel: "설치",
    channelLabel: "릴리스 채널",
    stable: "안정판",
    nightly: "nightly",
    terminal: "터미널",
    downloadForMac: "macOS용 다운로드",
    downloadForWindows: "Windows용 다운로드",
    downloadForLinux: "Linux용 다운로드",
    downloadAction: "다운로드",
    copyAction: "복사",
    copied: "복사됨",
    alsoOn: "다른 플랫폼",
    voicesLabel: "사용자들의 말",
    endorsementsTitle: "{users}명이 넘는 개발자가 참고 쓰는 중",
    readPost: "X에서 {handle}님의 게시물 읽기",
    showMore: "더 보기",
    faqLabel: "자주 묻는 질문",
    faqs: [
      {
        question: "T3 Code는 얼마인가요?",
        answer:
          "무료입니다. T3 Code는 MIT 라이선스의 오픈 소스입니다. 제공업체에는 지금처럼 그대로 결제하면 되고, T3 Connect는 기기 3대까지 무료입니다.",
      },
      {
        question: "Claude Code나 ChatGPT 구독을 쓸 수 있나요?",
        answer:
          "네. T3 Code는 이미 결제 중인 요금제로 Claude Code, Codex, Cursor, Grok Build, OpenCode, Antigravity, Pi, Muse Code를 실행합니다.",
      },
      {
        question: "구독을 쓰면 계정이 정지되나요?",
        answer:
          "아니요. T3 Code는 Claude Code, Codex, Google Antigravity의 약관을 준수하며, Grok Build와 Cursor 연동은 해당 팀과 함께 만들었습니다.",
      },
      {
        question: "T3 Code는 하네스인가요?",
        answer:
          "아니요. Claude Code나 Codex 같은 하네스는 모델을 에이전트로 만들어 줍니다. T3 Code는 그 하네스를 실행하는 앱이라, 작업 방식을 바꾸지 않고 서로 전환할 수 있습니다.",
      },
      {
        question: "제 코드가 T3 서버로 전송되나요?",
        answer:
          "아니요. 코드와 프롬프트는 내 기기에서 제공업체로 바로 전송됩니다. T3 Code는 기본적인 사용 이벤트만 보내고, 프롬프트나 파일 내용은 절대 보내지 않으며, 이 전송도 끌 수 있습니다.",
      },
      {
        question: "휴대폰이나 다른 컴퓨터에서 쓸 수 있나요?",
        answer:
          "네. 에이전트는 T3 Code가 설치된 기기에서 실행됩니다. iOS·Android 앱이나 app.t3.codes에서 T3 Connect, Tailscale 또는 로컬 네트워크로 연결하세요.",
      },
      {
        question: "Windows, Mac, Linux에서 되나요?",
        answer: "네, 세 가지 모두 지원합니다. 데스크톱 앱이나 t3 명령으로 쓸 수 있습니다.",
      },
    ],
  },
  features: {
    title: "기능 | T3 Code",
    description:
      "T3 Code가 하는 모든 일: 원격 제어, 스레드 하나에 모든 에이전트, 쓰던 구독 그대로, 그리고 MIT 라이선스 코드베이스.",
    items: {
      anywhere: {
        title: "어디서든 내 기기를 조작",
        body: "에이전트는 집에서 계속 실행됩니다. 브라우저나 휴대폰으로 지시하세요.",
      },
      machines: {
        title: "다른 기기도 제어",
        body: "Mac mini, Linux 머신, VPS를 연결하고 앱 하나에서 모두 에이전트를 돌리세요.",
      },
      agents: {
        title: "모든 에이전트, 스레드 하나",
        body: "원할 때 언제든 에이전트를 바꾸세요.",
      },
      subscriptions: {
        title: "쓰던 구독 그대로",
        body: "이미 결제 중인 요금제로 로그인하세요.",
      },
      open: {
        title: "속까지 오픈",
        body: "모든 코드가 GitHub에 있습니다. 포크하세요.",
      },
    },
  },
  download: {
    title: "macOS, Windows, Linux용 T3 Code 다운로드 | T3 Code",
    description:
      "macOS, Windows, Linux용 공식 T3 Code 데스크톱 앱을 다운로드하거나 iOS 및 Android 앱을 받으세요. 공식 다운로드 사이트는 t3.codes뿐입니다.",
    breadcrumb: "다운로드",
    heading: "T3 Code 다운로드",
    channelLabel: "릴리스 채널",
    stable: "안정판",
    nightly: "Nightly",
    intelNote: "Intel Mac을 쓰시나요? {link}.",
    intelLink: "x64 빌드 다운로드",
    armNote: "ARM을 쓰시나요? arm64 {deb} 또는 {appimage}를 다운로드하세요.",
    mobile: "모바일",
    iphoneIpad: "iPhone & iPad",
    allBuilds: "모든 빌드는 {link}에 있습니다",
    releasesPage: "GitHub 릴리스 페이지",
    builtAgo: "{age} 빌드됨",
    releasesFallback: "릴리스",
  },
};
