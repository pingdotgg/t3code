import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { CRUD, Plan } from "../Plan.ts";
import { Cli } from "./Cli.ts";
import type { ApplyEvent, ApplyStatus } from "./Event.ts";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const useColor = process.stdout.hasColors?.() ?? !!process.stdout.isTTY;
const c = (code: string, s: string) =>
  useColor ? `${ESC}${code}m${s}${RESET}` : s;
const dim = (s: string) => c("2", s);
const bold = (s: string) => c("1", s);
const red = (s: string) => c("31", s);
const green = (s: string) => c("32", s);
const yellow = (s: string) => c("33", s);
const blue = (s: string) => c("34", s);
const magenta = (s: string) => c("35", s);
const cyan = (s: string) => c("36", s);

const actionColor: Record<CRUD["action"], (s: string) => string> = {
  create: green,
  update: yellow,
  replace: magenta,
  delete: red,
  noop: dim,
};

const statusColor = (status: ApplyStatus): ((s: string) => string) => {
  switch (status) {
    case "created":
    case "updated":
    case "replaced":
      return green;
    case "deleted":
      return dim;
    case "fail":
      return red;
    case "attaching":
    case "post-attach":
      return cyan;
    default:
      return yellow;
  }
};

const tag = (id: string) => bold(`[${id}]`);

const isTerminal = (status: ApplyStatus): boolean =>
  status === "created" ||
  status === "updated" ||
  status === "deleted" ||
  status === "replaced" ||
  status === "fail";

const formatPlanLines = (plan: Plan): string[] => {
  const items = [
    ...Object.values(plan.resources),
    ...Object.values(plan.deletions),
  ] as CRUD[];
  if (items.length === 0) return [bold("Plan:") + " no changes"];

  const counts = items.reduce(
    (acc, item) => ((acc[item.action] = (acc[item.action] ?? 0) + 1), acc),
    {} as Record<CRUD["action"], number>,
  );
  const summary = (["create", "update", "replace", "delete", "noop"] as const)
    .filter((a) => counts[a])
    .map((a) => actionColor[a](`${counts[a]} to ${a}`))
    .join(dim(", "));

  const sorted = [...items].sort((a, b) =>
    a.resource.LogicalId.localeCompare(b.resource.LogicalId),
  );
  const lines = [`${bold("Plan:")} ${summary}`];
  for (const item of sorted) {
    const action = actionColor[item.action](item.action);
    lines.push(`${tag(item.resource.LogicalId)} ${action}`);
    for (const binding of item.bindings) {
      if (binding.action === "noop") continue;
      const bindingAction = actionColor[binding.action](binding.action);
      lines.push(
        `${tag(`${item.resource.LogicalId}/${binding.sid}`)} ${bindingAction}`,
      );
    }
  }
  return lines;
};

export const LoggingCli = Layer.succeed(
  Cli,
  Cli.of({
    approvePlan: (plan) =>
      Effect.gen(function* () {
        for (const line of formatPlanLines(plan)) yield* Console.log(line);
        yield* Console.log(
          `\n${yellow("Non-interactive terminal detected.")} Pass ${bold("--yes")} to approve, or set ${bold("ALCHEMY_TUI=1")} for the interactive UI.`,
        );
        return false;
      }),
    displayPlan: (plan) =>
      Effect.gen(function* () {
        for (const line of formatPlanLines(plan)) yield* Console.log(line);
      }),
    startApplySession: (plan) =>
      Effect.gen(function* () {
        for (const line of formatPlanLines(plan)) yield* Console.log(line);
        yield* Console.log("");

        const counts = { ok: 0, fail: 0 };
        return {
          emit: (event: ApplyEvent) =>
            Effect.sync(() => {
              if (event.kind === "annotate") {
                console.log(`${tag(event.id)} ${blue(event.message)}`);
                return;
              }
              const id = event.bindingId
                ? `${event.id}/${event.bindingId}`
                : event.id;
              const status = statusColor(event.status)(event.status);
              const msg = event.message ? ` ${dim("—")} ${event.message}` : "";
              console.log(`${tag(id)} ${status}${msg}`);
              if (isTerminal(event.status)) {
                if (event.status === "fail") counts.fail++;
                else counts.ok++;
              }
            }),
          done: () =>
            Console.log(
              `\n${bold("Done:")} ${green(`${counts.ok} succeeded`)}${counts.fail ? dim(", ") + red(`${counts.fail} failed`) : ""}`,
            ),
        };
      }),
  }),
);
