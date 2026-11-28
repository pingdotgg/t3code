import type {
  RelayAgentActivityAggregateState,
  RelayAgentActivityText,
  RelayAgentAwarenessPhase,
} from "@t3tools/contracts/relay";

type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>> & { readonly other: string };

interface CopyTable {
  readonly status: Readonly<Record<RelayAgentAwarenessPhase, string>>;
  readonly statusLine: string;
  readonly agentsNeedAttention: PluralForms;
  readonly agentsFinished: PluralForms;
  readonly workInProgress: string;
  readonly outOfDate: string;
  readonly failed: string;
  readonly done: string;
  readonly workFailed: string;
  readonly workCompleted: string;
  readonly statusOutOfDate: string;
  readonly approval: string;
  readonly input: string;
  readonly noActiveAgents: string;
  readonly activeAgents: PluralForms;
  readonly active: PluralForms;
  readonly needAttention: PluralForms;
}

// Wording matches the mobile catalogs (apps/mobile/src/i18n/translations), which the app itself
// shows for the same Live Activity before the relay's first push.
const COPY = {
  en: {
    status: {
      starting: "Connecting",
      running: "Working",
      waiting_for_approval: "Approval",
      waiting_for_input: "Input",
      completed: "Done",
      failed: "Failed",
      stale: "Waiting",
    },
    statusLine: "{status}: {project}",
    agentsNeedAttention: {
      one: "{count} agent needs attention",
      other: "{count} agents need attention",
    },
    agentsFinished: { one: "{count} agent finished", other: "{count} agents finished" },
    workInProgress: "Agent work in progress",
    outOfDate: "Out of date",
    failed: "Failed",
    done: "Done",
    workFailed: "Agent work failed",
    workCompleted: "Agent work completed",
    statusOutOfDate: "Agent status out of date",
    approval: "Approval",
    input: "Input",
    noActiveAgents: "No active agents",
    activeAgents: { one: "{count} active agent", other: "{count} active agents" },
    active: { other: "{count} active" },
    needAttention: { one: "{count} needs attention", other: "{count} need attention" },
  },
  de: {
    status: {
      starting: "Verbindet",
      running: "Arbeitet",
      waiting_for_approval: "Genehmigung",
      waiting_for_input: "Eingabe",
      completed: "Fertig",
      failed: "Fehlgeschlagen",
      stale: "Wartet",
    },
    statusLine: "{status}: {project}",
    agentsNeedAttention: {
      one: "{count} Agent braucht Aufmerksamkeit",
      other: "{count} Agenten brauchen Aufmerksamkeit",
    },
    agentsFinished: { one: "{count} Agent fertig", other: "{count} Agenten fertig" },
    workInProgress: "Agentenarbeit läuft",
    outOfDate: "Veraltet",
    failed: "Fehlgeschlagen",
    done: "Fertig",
    workFailed: "Agentenarbeit fehlgeschlagen",
    workCompleted: "Agentenarbeit abgeschlossen",
    statusOutOfDate: "Agentenstatus veraltet",
    approval: "Genehmigung",
    input: "Eingabe",
    noActiveAgents: "Keine aktiven Agenten",
    activeAgents: { one: "{count} aktiver Agent", other: "{count} aktive Agenten" },
    active: { other: "{count} aktiv" },
    needAttention: {
      one: "{count} braucht Aufmerksamkeit",
      other: "{count} brauchen Aufmerksamkeit",
    },
  },
  es: {
    status: {
      starting: "Conectando",
      running: "Trabajando",
      waiting_for_approval: "Aprobación",
      waiting_for_input: "Respuesta",
      completed: "Terminado",
      failed: "Con errores",
      stale: "Esperando",
    },
    statusLine: "{status}: {project}",
    agentsNeedAttention: {
      one: "{count} agente requiere atención",
      other: "{count} agentes requieren atención",
    },
    agentsFinished: { one: "{count} agente terminó", other: "{count} agentes terminaron" },
    workInProgress: "Trabajo de agentes en curso",
    outOfDate: "Desactualizado",
    failed: "Con errores",
    done: "Terminado",
    workFailed: "El trabajo del agente falló",
    workCompleted: "El trabajo del agente terminó",
    statusOutOfDate: "Estado del agente desactualizado",
    approval: "Aprobación",
    input: "Respuesta",
    noActiveAgents: "No hay agentes activos",
    activeAgents: { one: "{count} agente activo", other: "{count} agentes activos" },
    active: { one: "{count} activo", other: "{count} activos" },
    needAttention: { one: "{count} requiere atención", other: "{count} requieren atención" },
  },
  fr: {
    status: {
      starting: "Connexion",
      running: "En cours",
      waiting_for_approval: "Approbation",
      waiting_for_input: "Réponse",
      completed: "Terminé",
      failed: "En échec",
      stale: "En attente",
    },
    statusLine: "{status} : {project}",
    agentsNeedAttention: {
      one: "{count} agent demande votre attention",
      other: "{count} agents demandent votre attention",
    },
    agentsFinished: { one: "{count} agent a terminé", other: "{count} agents ont terminé" },
    workInProgress: "Travail des agents en cours",
    outOfDate: "Obsolète",
    failed: "En échec",
    done: "Terminé",
    workFailed: "Échec du travail de l’agent",
    workCompleted: "Travail de l’agent terminé",
    statusOutOfDate: "Statut de l’agent obsolète",
    approval: "Approbation",
    input: "Réponse",
    noActiveAgents: "Aucun agent actif",
    activeAgents: { one: "{count} agent actif", other: "{count} agents actifs" },
    active: { one: "{count} actif", other: "{count} actifs" },
    needAttention: {
      one: "{count} demande votre attention",
      other: "{count} demandent votre attention",
    },
  },
  ja: {
    status: {
      starting: "接続中",
      running: "作業中",
      waiting_for_approval: "承認",
      waiting_for_input: "入力",
      completed: "完了",
      failed: "失敗",
      stale: "待機中",
    },
    statusLine: "{status}：{project}",
    agentsNeedAttention: { other: "{count} 個のエージェントが確認を必要としています" },
    agentsFinished: { other: "{count} 個のエージェントの作業が完了しました" },
    workInProgress: "エージェントが作業中",
    outOfDate: "古い情報",
    failed: "失敗",
    done: "完了",
    workFailed: "エージェントの作業に失敗しました",
    workCompleted: "エージェントの作業が完了しました",
    statusOutOfDate: "エージェントのステータスが古くなっています",
    approval: "承認",
    input: "入力",
    noActiveAgents: "アクティブなエージェントはありません",
    activeAgents: { other: "アクティブなエージェント {count} 個" },
    active: { other: "{count} 個がアクティブ" },
    needAttention: { other: "{count} 件の確認が必要" },
  },
  ko: {
    status: {
      starting: "연결 중",
      running: "작업 중",
      waiting_for_approval: "승인",
      waiting_for_input: "입력",
      completed: "완료",
      failed: "실패",
      stale: "대기 중",
    },
    statusLine: "{status}: {project}",
    agentsNeedAttention: { other: "에이전트 {count}개 확인 필요" },
    agentsFinished: { other: "에이전트 {count}개 완료" },
    workInProgress: "에이전트 작업 진행 중",
    outOfDate: "오래됨",
    failed: "실패",
    done: "완료",
    workFailed: "에이전트 작업 실패",
    workCompleted: "에이전트 작업 완료",
    statusOutOfDate: "에이전트 상태가 오래됨",
    approval: "승인",
    input: "입력",
    noActiveAgents: "활성 에이전트 없음",
    activeAgents: { other: "활성 에이전트 {count}개" },
    active: { other: "{count}개 활성" },
    needAttention: { other: "{count}개 확인 필요" },
  },
  "pt-BR": {
    status: {
      starting: "Conectando",
      running: "Trabalhando",
      waiting_for_approval: "Aprovação",
      waiting_for_input: "Resposta",
      completed: "Concluído",
      failed: "Falhou",
      stale: "Aguardando",
    },
    statusLine: "{status}: {project}",
    agentsNeedAttention: {
      one: "{count} agente precisa de atenção",
      other: "{count} agentes precisam de atenção",
    },
    agentsFinished: { one: "{count} agente terminou", other: "{count} agentes terminaram" },
    workInProgress: "Trabalho de agentes em andamento",
    outOfDate: "Desatualizado",
    failed: "Falhou",
    done: "Concluído",
    workFailed: "O trabalho do agente falhou",
    workCompleted: "Trabalho do agente concluído",
    statusOutOfDate: "Status do agente desatualizado",
    approval: "Aprovação",
    input: "Resposta",
    noActiveAgents: "Nenhum agente ativo",
    activeAgents: { one: "{count} agente ativo", other: "{count} agentes ativos" },
    active: { one: "{count} ativo", other: "{count} ativos" },
    needAttention: { one: "{count} precisa de atenção", other: "{count} precisam de atenção" },
  },
  ru: {
    status: {
      starting: "Подключение",
      running: "Работает",
      waiting_for_approval: "Подтверждение",
      waiting_for_input: "Ввод",
      completed: "Готово",
      failed: "Ошибка",
      stale: "Ожидание",
    },
    statusLine: "{status}: {project}",
    agentsNeedAttention: {
      one: "{count} агент требует внимания",
      few: "{count} агента требуют внимания",
      many: "{count} агентов требуют внимания",
      other: "{count} агента требуют внимания",
    },
    agentsFinished: {
      one: "{count} агент завершил работу",
      few: "{count} агента завершили работу",
      many: "{count} агентов завершили работу",
      other: "{count} агента завершили работу",
    },
    workInProgress: "Агент работает",
    outOfDate: "Устарело",
    failed: "Ошибка",
    done: "Готово",
    workFailed: "Работа агента завершилась ошибкой",
    workCompleted: "Работа агента завершена",
    statusOutOfDate: "Статус агента устарел",
    approval: "Подтверждение",
    input: "Ввод",
    noActiveAgents: "Нет активных агентов",
    activeAgents: {
      one: "{count} активный агент",
      few: "{count} активных агента",
      many: "{count} активных агентов",
      other: "{count} активного агента",
    },
    active: { one: "Активен {count}", other: "Активно {count}" },
    needAttention: { one: "{count} требует внимания", other: "{count} требуют внимания" },
  },
  sv: {
    status: {
      starting: "Ansluter",
      running: "Arbetar",
      waiting_for_approval: "Godkännande",
      waiting_for_input: "Indata",
      completed: "Klar",
      failed: "Misslyckades",
      stale: "Väntar",
    },
    statusLine: "{status}: {project}",
    agentsNeedAttention: {
      one: "{count} agent behöver uppmärksamhet",
      other: "{count} agenter behöver uppmärksamhet",
    },
    agentsFinished: { one: "{count} agent är klar", other: "{count} agenter är klara" },
    workInProgress: "Agentarbete pågår",
    outOfDate: "Inaktuell",
    failed: "Misslyckades",
    done: "Klar",
    workFailed: "Agentens arbete misslyckades",
    workCompleted: "Agentens arbete slutfördes",
    statusOutOfDate: "Agentstatus inaktuell",
    approval: "Godkännande",
    input: "Indata",
    noActiveAgents: "Inga aktiva agenter",
    activeAgents: { one: "{count} aktiv agent", other: "{count} aktiva agenter" },
    active: { one: "{count} aktiv", other: "{count} aktiva" },
    needAttention: { other: "{count} behöver uppmärksamhet" },
  },
  zh: {
    status: {
      starting: "正在连接",
      running: "运行中",
      waiting_for_approval: "待批准",
      waiting_for_input: "待输入",
      completed: "完成",
      failed: "失败",
      stale: "等待中",
    },
    statusLine: "{status}：{project}",
    agentsNeedAttention: { other: "{count} 个智能体需要关注" },
    agentsFinished: { other: "{count} 个智能体已完成" },
    workInProgress: "智能体工作进行中",
    outOfDate: "已过时",
    failed: "失败",
    done: "完成",
    workFailed: "智能体工作失败",
    workCompleted: "智能体工作已完成",
    statusOutOfDate: "智能体状态已过期",
    approval: "待批准",
    input: "待输入",
    noActiveAgents: "没有活跃的智能体",
    activeAgents: { other: "{count} 个活跃智能体" },
    active: { other: "{count} 个活跃" },
    needAttention: { other: "{count} 个需要关注" },
  },
} satisfies Record<string, CopyTable>;

export type AgentActivityLocale = keyof typeof COPY;

const LOCALES = Object.keys(COPY) as ReadonlyArray<AgentActivityLocale>;

/** Maps a device's language tag to a supported locale, or null when only English fits. */
export function resolveAgentActivityLocale(
  value: string | null | undefined,
): AgentActivityLocale | null {
  if (!value) return null;
  const tag = value.trim().toLowerCase();
  const language = tag.split(/[-_]/)[0];
  return (
    LOCALES.find((locale) => locale.toLowerCase() === tag) ??
    LOCALES.find((locale) => locale.toLowerCase().split("-")[0] === language) ??
    null
  );
}

export interface AgentActivityCopy {
  readonly status: (phase: RelayAgentAwarenessPhase) => string;
  readonly statusLine: (status: string, project: string) => string;
  readonly agentsNeedAttention: (count: number) => string;
  readonly agentsFinished: (count: number) => string;
  readonly subtitle: (aggregate: RelayAgentActivityAggregateState) => string;
  readonly text: (aggregate: RelayAgentActivityAggregateState) => RelayAgentActivityText;
}

function makeCopy(locale: AgentActivityLocale): AgentActivityCopy {
  const table: CopyTable = COPY[locale];
  const rules = new Intl.PluralRules(locale);
  const plural = (forms: PluralForms, count: number) =>
    (forms[rules.select(count)] ?? forms.other).replaceAll("{count}", String(count));
  const counts = (forms: PluralForms, values: ReadonlyArray<number>) =>
    Object.fromEntries(values.map((count) => [String(count), plural(forms, count)]));
  return {
    status: (phase) => table.status[phase],
    // Replacer functions keep `$` sequences in titles literal.
    statusLine: (status, project) =>
      table.statusLine.replace("{status}", () => status).replace("{project}", () => project),
    agentsNeedAttention: (count) => plural(table.agentsNeedAttention, count),
    agentsFinished: (count) => plural(table.agentsFinished, count),
    subtitle: (aggregate) =>
      aggregate.activeCount > 0
        ? table.workInProgress
        : aggregate.activities[0]?.phase === "failed"
          ? table.workFailed
          : table.workCompleted,
    // Only the counts this aggregate can show, to stay inside the APNs payload budget.
    text: (aggregate) => {
      const activeCounts = aggregate.activeCount > 0 ? [aggregate.activeCount] : [];
      const rowCounts = aggregate.activities.map((_, index) => index + 1);
      return {
        outOfDate: table.outOfDate,
        failed: table.failed,
        done: table.done,
        workFailed: table.workFailed,
        workCompleted: table.workCompleted,
        statusOutOfDate: table.statusOutOfDate,
        approval: table.approval,
        input: table.input,
        noActiveAgents: table.noActiveAgents,
        activeAgents: counts(table.activeAgents, activeCounts),
        active: counts(table.active, activeCounts),
        needAttention: counts(table.needAttention, rowCounts),
        needYou: {},
      };
    },
  };
}

const copies = new Map(LOCALES.map((locale) => [locale, makeCopy(locale)]));

export const ENGLISH_AGENT_ACTIVITY_COPY = copies.get("en")!;

/** Copy for a device's stored locale; unknown or missing locales get English. */
export function agentActivityCopy(locale: string | null | undefined): AgentActivityCopy {
  const resolved = resolveAgentActivityLocale(locale);
  return (resolved && copies.get(resolved)) || ENGLISH_AGENT_ACTIVITY_COPY;
}

/**
 * Copy for Live Activity content. English devices get none: the widget's built-in English matches,
 * and the payload keeps room for a fifth row.
 */
export function liveActivityCopy(locale: string | null | undefined): AgentActivityCopy | undefined {
  const copy = agentActivityCopy(locale);
  return copy === ENGLISH_AGENT_ACTIVITY_COPY ? undefined : copy;
}

/** Rewrites relay-authored row statuses and the subtitle into the device's language. */
export function localizeAggregateState(
  aggregate: RelayAgentActivityAggregateState,
  copy: AgentActivityCopy,
): RelayAgentActivityAggregateState {
  return {
    ...aggregate,
    subtitle: copy.subtitle(aggregate),
    activities: aggregate.activities.map((row) => ({ ...row, status: copy.status(row.phase) })),
  };
}
