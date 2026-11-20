import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { parseTickets, type TicketStage } from "../domain/ticket";
import template from "./brief.md?raw";
import { DEFAULT_ROLES, type ResolvedRole } from "./roles";

export interface BriefInput {
  /** The board folder's absolute path. */
  readonly boardDir: string;
  readonly builderCap: number;
  readonly roles?: ReadonlyArray<ResolvedRole>;
}

function targetText(role: ResolvedRole): string {
  const { target } = role;
  if (target === null) return "omit";
  const instance =
    target.providerInstanceId === undefined
      ? ""
      : `"providerInstanceId":"${target.providerInstanceId}",`;
  return `\`{${instance}"model":"${target.model}","options":{"effort":"${target.effort}"}}\``;
}

function rolesTable(roles: ReadonlyArray<ResolvedRole>): string {
  const rows = roles.map(
    (role) =>
      `| \`${role.name}\` | ${(role.description.split(/(?<=\.)\s/)[0] ?? role.description).replaceAll("|", "\\|")} | \`${role.t3Role}\` | \`${role.isolation}\` | ${targetText(role)} | ${role.readOnly ? "yes" : "no"} |`,
  );
  const notes = roles.flatMap((role) => (role.fallback === null ? [] : [`- ${role.fallback}.`]));
  return [
    "| Role | Use for | `role` | `isolation` | `target` | Read-only |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    ...(notes.length > 0 ? ["", ...notes] : []),
  ].join("\n");
}

/** The orchestrator's first message, with the board's folder, builder cap, and role registry filled in. */
export function renderBrief(input: BriefInput): string {
  return template
    .replaceAll("{{boardDir}}", input.boardDir)
    .replaceAll("{{builderCap}}", String(input.builderCap))
    .replaceAll("{{roles}}", rolesTable(input.roles ?? DEFAULT_ROLES));
}

export interface StoreFiles {
  /** The text of each store file, or null when the orchestrator has not written it yet. */
  readonly tickets: string | null;
  readonly forYou: string | null;
  readonly decisions: string | null;
}

export interface OrchestratorStats {
  readonly stages: Readonly<Record<TicketStage, number>>;
  readonly ticketTotal: number;
  readonly forYouOpen: number;
  readonly buildersInUse: number;
  readonly builderCap: number;
  /** The newest line of `decisions.tsv`: its time and its decision. */
  readonly latestDecision: { readonly time: string; readonly decision: string } | null;
  /** One line for each store file the orchestrator wrote that could not be read in full. */
  readonly problems: ReadonlyArray<string>;
}

const ForYouLine = Schema.Struct({ id: Schema.String, status: Schema.String });

const decodeForYouLine = Schema.decodeUnknownOption(Schema.fromJsonString(ForYouLine));

/**
 * What the orchestrator card shows. A building agent is one ticket in `building`, and an item is
 * open while its latest line says so, because the orchestrator resolves an item by appending a line.
 */
export function orchestratorStats(files: StoreFiles, builderCap: number): OrchestratorStats {
  const problems: string[] = [];
  const stages = {
    planned: 0,
    building: 0,
    reviewing: 0,
    verifying: 0,
    pr: 0,
    awaiting_approval: 0,
    merged: 0,
    off_path: 0,
  };

  if (files.tickets !== null) {
    const tickets = parseTickets(files.tickets);
    if (Result.isFailure(tickets)) problems.push(tickets.failure.message);
    else for (const ticket of tickets.success) stages[ticket.stage] += 1;
  }

  const latestStatus = new Map<string, string>();
  (files.forYou ?? "").split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    const item = decodeForYouLine(line);
    if (Option.isNone(item)) problems.push(`foryou.jsonl line ${index + 1} is not an item`);
    else latestStatus.set(item.value.id, item.value.status);
  });

  const decisionRows = (files.decisions ?? "")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.split("\t"));
  const [time, decision] = decisionRows.length > 1 ? (decisionRows.at(-1) ?? []) : [];

  return {
    stages,
    ticketTotal: Object.values(stages).reduce((sum, count) => sum + count, 0),
    forYouOpen: [...latestStatus.values()].filter((status) => status === "open").length,
    buildersInUse: stages.building,
    builderCap,
    latestDecision: time === undefined || decision === undefined ? null : { time, decision },
    problems,
  };
}
