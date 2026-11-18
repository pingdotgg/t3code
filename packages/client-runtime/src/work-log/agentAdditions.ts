import type {
  OrchestrationV2NotificationAddition,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";

/**
 * Gathers notification rows the server marks with `addition` (what reached, or was kept from,
 * the agent without the user typing it) into one "What reached the agent" panel per run of
 * adjacent rows. Web and mobile call `agentAdditionRunEnd` where they already walk timeline
 * entries, then `summarizeAgentAdditions` once per panel.
 */
export type AgentAdditionGroup = OrchestrationV2NotificationAddition["group"];

export type AgentAddition = Extract<OrchestrationV2TurnItem, { type: "notification" }> & {
  readonly addition: OrchestrationV2NotificationAddition;
};

const AGENT_ADDITION_GROUPS: ReadonlyArray<AgentAdditionGroup> = [
  "harness",
  "t3",
  "rules",
  "held",
  "blocked",
];

export interface AgentAdditionChip {
  readonly kind: AgentAdditionGroup | "failed";
  /** Signed characters for harness, t3 and rules; a row count otherwise. */
  readonly value: number;
}

/** A client's own timeline entry for a marked row, beside the row itself. */
export interface AgentAdditionRow {
  readonly item: AgentAddition;
}

export interface AgentAdditionsSummary<Row extends AgentAdditionRow> {
  readonly groups: ReadonlyArray<{
    readonly group: AgentAdditionGroup;
    readonly rows: ReadonlyArray<Row>;
  }>;
  readonly chips: ReadonlyArray<AgentAdditionChip>;
  /** A blocked message or a failed request, which must be noticeable while the panel is closed. */
  readonly warns: boolean;
}

export function isAgentAddition(
  item: OrchestrationV2TurnItem | null | undefined,
): item is AgentAddition {
  return item?.type === "notification" && item.addition !== undefined;
}

/** The index just past the adjacent marked rows that start at `start`; `start` when none does. */
export function agentAdditionRunEnd<T>(
  entries: ReadonlyArray<T>,
  start: number,
  itemOf: (entry: T) => OrchestrationV2TurnItem | null | undefined,
): number {
  let end = start;
  while (end < entries.length && isAgentAddition(itemOf(entries[end]!))) end += 1;
  return end;
}

export function summarizeAgentAdditions<Row extends AgentAdditionRow>(
  rows: ReadonlyArray<Row>,
): AgentAdditionsSummary<Row> {
  const byGroup = new Map<AgentAdditionGroup, Row[]>();
  for (const row of rows) {
    const list = byGroup.get(row.item.addition.group);
    if (list === undefined) byGroup.set(row.item.addition.group, [row]);
    else list.push(row);
  }
  const groups = AGENT_ADDITION_GROUPS.flatMap((group) => {
    const groupRows = byGroup.get(group);
    return groupRows === undefined ? [] : [{ group, rows: groupRows }];
  });
  const chips: AgentAdditionChip[] = [];
  let failed = 0;
  for (const { group, rows: groupRows } of groups) {
    if (group === "held" || group === "blocked") {
      chips.push({ kind: group, value: groupRows.length });
      continue;
    }
    let characters: number | undefined;
    for (const { item } of groupRows) {
      if (item.outcome === "failed") failed += 1;
      if (item.addition.characters !== undefined) {
        characters = (characters ?? 0) + item.addition.characters;
      }
    }
    if (characters !== undefined) chips.push({ kind: group, value: characters });
  }
  if (failed > 0) chips.push({ kind: "failed", value: failed });
  return { groups, chips, warns: failed > 0 || byGroup.has("blocked") };
}

/** Signed and abbreviated past a thousand: `+86`, `+92.7k`, `−18.4k`. */
export function formatAdditionCharacters(characters: number): string {
  const sign = characters < 0 ? "−" : "+";
  const size = Math.abs(characters);
  const short =
    size >= 1_000_000
      ? `${trimTenths(size / 1_000_000)}M`
      : size >= 1_000
        ? `${trimTenths(size / 1_000)}k`
        : String(size);
  return `${sign}${short}`;
}

const trimTenths = (value: number) => value.toFixed(1).replace(/\.0$/, "");
