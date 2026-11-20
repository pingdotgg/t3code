import * as Result from "effect/Result";

import { mergeForYou, openCards } from "../domain/forYou";
import { parseTickets, type TicketStage } from "../domain/ticket";
import template from "./brief.md?raw";
import { DEFAULT_ROLES, type ResolvedRole } from "./roles";

/** What differs between boards, which the first message carries. */
export interface BoardFacts {
  /** The board folder's absolute path. */
  readonly boardDir: string;
  readonly builderCap: number;
  readonly project: string;
  /** The project's absolute path, which is the orchestrator's working folder. */
  readonly projectDir: string;
}

export interface BriefInput extends BoardFacts {
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

const FACTS_AT = template.indexOf("# Board facts");
const RULES = template.slice(0, FACTS_AT).trimEnd();
const FACTS = template.slice(FACTS_AT);

/** The rules every board's orchestrator follows, with the role registry filled in. They hold nothing about one board. */
export function renderRules(roles: ReadonlyArray<ResolvedRole> = DEFAULT_ROLES): string {
  return RULES.replaceAll("{{roles}}", rolesTable(roles));
}

/** The board's folder, builder cap, and project. */
export function renderFacts(input: BoardFacts): string {
  return FACTS.replaceAll("{{boardDir}}", input.boardDir)
    .replaceAll("{{builderCap}}", String(input.builderCap))
    .replaceAll("{{project}}", input.project)
    .replaceAll("{{projectDir}}", input.projectDir);
}

/** The rules and the board facts in one message, for an orchestrator that has no standing instructions. */
export function renderBrief(input: BriefInput): string {
  return `${renderRules(input.roles)}\n\n${renderFacts(input)}`;
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
  /** Why `tickets.json` could not be read in full. A bad `foryou.jsonl` line shows in the board's banner. */
  readonly problems: ReadonlyArray<string>;
}

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

  const forYou = mergeForYou(files.forYou, []);

  const decisionRows = (files.decisions ?? "")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.split("\t"));
  const [time, decision] = decisionRows.length > 1 ? (decisionRows.at(-1) ?? []) : [];

  return {
    stages,
    ticketTotal: Object.values(stages).reduce((sum, count) => sum + count, 0),
    forYouOpen: openCards(forYou.cards).length,
    buildersInUse: stages.building,
    builderCap,
    latestDecision: time === undefined || decision === undefined ? null : { time, decision },
    problems,
  };
}
