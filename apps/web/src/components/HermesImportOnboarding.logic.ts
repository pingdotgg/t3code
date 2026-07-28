import type { HermesDiscoveredSession } from "@t3tools/contracts";

const DAY_MS = 24 * 60 * 60 * 1_000;

export interface HermesImportSummary {
  readonly total: number;
  readonly ready: number;
  readonly alreadyImported: number;
  readonly unsettled: number;
  readonly settled: number;
  readonly transports: ReadonlyArray<{ readonly source: string; readonly count: number }>;
}

export interface HermesImportStatus {
  readonly title: string;
  readonly description: string;
}

export function describeHermesImportStatus(
  summary: HermesImportSummary,
  ageLabel: string,
): HermesImportStatus {
  if (summary.total === 0) {
    return {
      title: "No matching conversations",
      description: `No conversations started within the last ${ageLabel}.`,
    };
  }
  if (summary.ready === 0) {
    return {
      title: "Hermes is up to date",
      description: `All ${summary.total} matching conversation${summary.total === 1 ? " is" : "s are"} already in T3 Work.`,
    };
  }
  return {
    title: `${summary.ready} conversation${summary.ready === 1 ? "" : "s"} ready to import`,
    description: `${summary.unsettled} started in the last 72 hours will remain unsettled; ${summary.settled} older will start settled.`,
  };
}

export function summarizeHermesImportSessions(
  sessions: ReadonlyArray<HermesDiscoveredSession>,
  activeWithinDays: number,
  nowMillis: number,
): HermesImportSummary {
  const counts = new Map<string, number>();
  let ready = 0;
  let unsettled = 0;
  const matchingSessions = sessions.filter(
    (session) => session.startedAt * 1_000 >= nowMillis - activeWithinDays * DAY_MS,
  );
  for (const session of matchingSessions) {
    counts.set(session.source, (counts.get(session.source) ?? 0) + 1);
    if (session.importedThreadId !== null) continue;
    ready += 1;
    if (session.settlement === "unsettled") unsettled += 1;
  }
  return {
    total: matchingSessions.length,
    ready,
    alreadyImported: matchingSessions.length - ready,
    unsettled,
    settled: ready - unsettled,
    transports: [...counts]
      .map(([source, count]) => ({ source, count }))
      .sort((left, right) => left.source.localeCompare(right.source)),
  };
}

export function hermesTransportLabel(source: string): string {
  const known: Readonly<Record<string, string>> = {
    api_server: "API server",
    bluebubbles: "BlueBubbles",
    dingtalk: "DingTalk",
    discord: "Discord",
    email: "Email",
    feishu: "Feishu",
    homeassistant: "Home Assistant",
    matrix: "Matrix",
    mattermost: "Mattermost",
    msgraph_webhook: "Microsoft Graph",
    qqbot: "QQ Bot",
    signal: "Signal",
    slack: "Slack",
    sms: "SMS",
    telegram: "Telegram",
    wecom: "WeCom",
    wecom_callback: "WeCom callback",
    webhook: "Webhook",
    weixin: "Weixin",
    whatsapp: "WhatsApp",
    whatsapp_cloud: "WhatsApp Cloud",
    yuanbao: "Yuanbao",
  };
  return known[source] ?? source.replaceAll("_", " ");
}
