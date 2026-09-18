import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Prompt from "effect/unstable/cli/Prompt";
import { inspect } from "node:util";
import type { ActionApply, ActionDelete, CRUD, Plan } from "../Plan.ts";
import { Cli, type PlanDisplayOptions } from "../Report.ts";
import { canPromptOnStdin } from "../Util/interactive.ts";
import { NonInteractiveTerminal } from "../Interaction.ts";
import { ansiFg, colorsEnabled, theme } from "./CliKit/index.ts";
import { formatElapsed } from "./Format.ts";
import {
  actionStyle,
  applyStatusColor,
  isTerminalStatus as isTerminal,
} from "./components/view/statusStyle.ts";
import type { ApplyEvent, ApplyStatus } from "../Report.ts";
import { formatModeNote } from "./ModeTag.ts";
import { formatResourceTag } from "../Util/ResourceOutput.ts";
import {
  formatDeclaredPropertyYaml,
  matchYamlChange,
  matchYamlKey,
} from "./PropertyDiff.ts";
import { actionHasPlannedWork, buildPlanSummary } from "./NamespaceTree.ts";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
// Shared with every other non-ink output path — notably it honors
// FORCE_COLOR, so lines emitted from the piped dev sidecar keep their color.
const useColor = colorsEnabled();
const c = (code: string, s: string) =>
  useColor ? `${ESC}${code}m${s}${RESET}` : s;
const hex = (color: string) => (s: string) =>
  useColor ? `${ansiFg(color)}${s}${RESET}` : s;
const dim = (s: string) => c("2", s);
const bold = (s: string) => c("1", s);
const red = hex(theme.color.danger);
const green = hex(theme.color.success);
const blue = hex(theme.color.accent);
const cyan = hex(theme.color.info);

// noop stays terminal-dim rather than brand-muted so it recedes in plain logs
const actionColor: Record<CRUD["action"], (s: string) => string> = {
  create: hex(actionStyle.create.color),
  update: hex(actionStyle.update.color),
  adopted: hex(actionStyle.adopted.color),
  replace: hex(actionStyle.replace.color),
  delete: hex(actionStyle.delete.color),
  orphaned: hex(actionStyle.orphaned.color),
  noop: dim,
};

// muted stays terminal-dim rather than brand-muted, matching `actionColor`.
const statusColor = (status: ApplyStatus): ((s: string) => string) => {
  const color = applyStatusColor(status);
  if (color === undefined || color === theme.color.muted) return dim;
  return hex(color);
};

const tag = formatResourceTag;

/**
 * In-progress statuses that represent real cloud work. Plain output has no
 * spinner, so these lines are the liveness signal in CI logs
 * (CloudFormation-style IN_PROGRESS rows). Bookkeeping transitions
 * (`pending`, `attaching`, `post-attach`) stay silent — they resolve in
 * milliseconds and would double the log for no information.
 */
const isActive = (status: ApplyStatus): boolean =>
  status === "pre-creating" ||
  status === "creating" ||
  status === "creating replacement" ||
  status === "updating" ||
  status === "adopting" ||
  status === "deleting" ||
  status === "orphaning" ||
  status === "replacing" ||
  status === "running";

/**
 * Dim `(local)` / `(remote)` / `(local → live)` suffix for a resource row,
 * or `""` when the row's mode matches the run default (the quiet common
 * case). See {@link formatModeNote} for the rule.
 */
const modeSuffix = (options: Parameters<typeof formatModeNote>[0]): string => {
  const note = formatModeNote(options);
  return note ? ` ${dim(`(${note})`)}` : "";
};

/** Exported for unit tests — pure plan-preview rendering. */
export const formatPlanLines = (
  plan: Plan,
  options: PlanDisplayOptions = {},
): string[] => {
  const allItems = [
    ...Object.values(plan.resources),
    ...Object.values(plan.deletions),
  ] as CRUD[];
  const tasks = [
    ...Object.values(plan.actions ?? {}),
    ...Object.values(plan.actionDeletions ?? {}),
  ]
    .filter((task): task is ActionApply | ActionDelete => task !== undefined)
    .filter(actionHasPlannedWork);
  if (allItems.length === 0 && tasks.length === 0) {
    return [`${bold("Plan:")} ${dim("no resources")}`];
  }

  const { counts, bindingChanges } = buildPlanSummary(plan);
  const summaryParts = (
    ["create", "update", "adopted", "replace", "delete", "orphaned"] as const
  )
    .filter((a) => counts[a])
    .map((a) => actionColor[a](`${counts[a]} to ${a}`));
  if (bindingChanges > 0) {
    summaryParts.push(cyan(`${bindingChanges} binding changes`));
  }
  if (tasks.length > 0) {
    summaryParts.push(cyan(`${tasks.length} tasks`));
  }
  const summary =
    summaryParts.length === 0
      ? dim("no changes")
      : summaryParts.join(dim(", "));

  const sorted = [...allItems].sort((a, b) =>
    a.resource.LogicalId.localeCompare(b.resource.LogicalId),
  );
  const lines = [`${bold("Plan:")} ${summary}`];
  if (options.detailed && sorted.length > 0) lines.push("");
  for (const [index, item] of sorted.entries()) {
    if (options.detailed && index > 0) lines.push("");
    const action = actionColor[item.action](item.action);
    const mode = modeSuffix({
      mode: item.mode,
      priorMode:
        item.action === "replace" ? item.state.providerMode : undefined,
      defaultMode: plan.defaultMode,
    });
    // Surface FQN migrations: `[Assets] update (renamed from Bucket)` —
    // the update exists to re-brand the moved row's physical resource, and
    // without the note the plan gives no hint why an untouched resource
    // reconciles. (Only apply-side nodes can carry a rename — see
    // `ApplyNodeBase`.)
    const renamed =
      "renamedFrom" in item && item.renamedFrom?.length
        ? ` ${dim(`(renamed from ${item.renamedFrom.join(", ")})`)}`
        : "";
    lines.push(`${tag(item.resource.FQN)} ${action}${mode}${renamed}`);
    for (const binding of [...item.bindings].sort((a, b) =>
      a.sid.localeCompare(b.sid),
    )) {
      const bindingAction =
        binding.action === "delete"
          ? dim("unbind")
          : actionColor[binding.action](binding.action);
      lines.push(
        `${tag(`${item.resource.FQN}/${binding.sid}`)} ${bindingAction}`,
      );
    }
    if (
      options.detailed &&
      (item.action === "create" ||
        item.action === "update" ||
        item.action === "adopted" ||
        item.action === "replace")
    ) {
      const document = formatDeclaredPropertyYaml(
        item.action === "create" ? {} : item.state.props,
        item.props,
        item.action === "adopted" ? "update" : item.action,
      );
      if (document === undefined) {
        lines.push(`  ${dim("no declared property changes")}`);
      } else {
        lines.push(
          ...document.lines.map(
            (line) => `  ${colorYamlLine(line, document.kind)}`,
          ),
        );
      }
    }
  }
  for (const task of tasks.sort((a, b) =>
    a.def.LogicalId.localeCompare(b.def.LogicalId),
  )) {
    lines.push(
      `${tag(task.def.FQN)} ${cyan(task.action === "delete" ? "drop" : "run")} ${dim("[action]")}`,
    );
  }
  return lines;
};

const colorYamlLine = (
  line: string,
  kind: "create" | "change" | "drift",
): string => {
  const change = matchYamlChange(line);
  if (change !== undefined) {
    const color = change.marker === "-" ? red : green;
    return color(`${change.marker} ${change.content}`);
  }
  const key = matchYamlKey(line);
  if (key === undefined) return line;
  const color = kind === "create" ? green : cyan;
  return `${key.indent}${color(key.key)}${key.value}`;
};

export const LoggingCli = Layer.effect(
  Cli,
  Effect.gen(function* () {
    // Captured at layer build so `approvePlan` keeps the CLIService signature
    // (no requirements on the returned Effects).
    const promptContext = yield* Effect.context<Prompt.Environment>();
    const confirm = (options: Prompt.ConfirmOptions) =>
      Prompt.Confirm(options).pipe(
        Effect.catchTag("QuitError", () => Effect.succeed(false)),
        Effect.provideContext(promptContext),
      );
    return Cli.of({
      startPlanningSession: (label, _detail, title) =>
        Effect.gen(function* () {
          // Same information as the interactive session, one plain line per
          // change: the title header carries the operation + stage once, each
          // phase prints as it starts, and the settle line carries the total
          // planning time (the spinner's implicit "how long did that take").
          const startedAt = yield* Clock.currentTimeMillis;
          if (title !== undefined) yield* Effect.logInfo(bold(title));
          yield* Effect.logInfo(dim(label));
          let closed = false;
          let lastLabel = label;
          const write = (nextLabel: string, _nextDetail?: string) =>
            Effect.suspend(() => {
              // Repeated updates within one phase (spinner detail refreshes)
              // carry nothing new for a line-per-change log.
              if (closed || nextLabel === lastLabel) return Effect.void;
              lastLabel = nextLabel;
              return Effect.logInfo(dim(nextLabel));
            });
          const finish = (message: string, paint: (s: string) => string) =>
            Effect.suspend(() => {
              if (closed) return Effect.void;
              closed = true;
              return Clock.currentTimeMillis.pipe(
                Effect.flatMap((now) =>
                  Effect.logInfo(
                    `${paint(message)} ${dim(`(${formatElapsed(now - startedAt)})`)}`,
                  ),
                ),
              );
            });
          return {
            update: write,
            succeed: (message = "Plan ready") => finish(message, green),
            fail: (message = "Planning failed") => finish(message, red),
            close: Effect.sync(() => {
              closed = true;
            }),
          };
        }),
      approvePlan: (plan, options) =>
        Effect.gen(function* () {
          for (const line of formatPlanLines(plan, options))
            yield* Effect.logInfo(line);
          if (canPromptOnStdin()) {
            return yield* confirm(
              plan.destroy === true
                ? { message: "Destroy these resources?", initial: false }
                : { message: "Apply this plan?", initial: true },
            );
          }
          return yield* Effect.fail(
            new NonInteractiveTerminal({
              operation: "approve deployment plan",
              message:
                "Cannot approve this operation without terminal input. Pass --yes to continue.",
            }),
          );
        }),
      displayPlan: (plan, options) =>
        Effect.gen(function* () {
          for (const line of formatPlanLines(plan, options))
            yield* Effect.logInfo(line);
        }),
      startApplySession: (plan, options) =>
        Effect.gen(function* () {
          for (const line of formatPlanLines(plan, options))
            yield* Effect.logInfo(line);
          yield* Effect.logInfo("");

          const startedAt = yield* Clock.currentTimeMillis;
          const started = new Map<string, number>();
          const terminal = new Map<string, ApplyStatus>();
          const notes = new Map<string, string>();
          const statusNotes = new Map<string, string>();
          return {
            setOutput: (value: unknown) =>
              Effect.logInfo(inspect(value, { colors: false })),
            // Progress is an Effect log record, just like provider and build
            // diagnostics, so the append-only renderer gives every line the
            // same timestamp / level / fiber prefix.
            emit: (event: ApplyEvent) =>
              Clock.currentTimeMillis.pipe(
                Effect.flatMap((now) =>
                  Effect.suspend(() => {
                    if (event._tag === "apply.resource.note") {
                      // `status` notes only surface as the settle line's suffix;
                      // everything else streams, deduping consecutive repeats.
                      if (event.kind === "status") {
                        statusNotes.set(event.fqn, event.message);
                        return Effect.void;
                      }
                      if (notes.get(event.fqn) === event.message)
                        return Effect.void;
                      notes.set(event.fqn, event.message);
                      return Effect.logInfo(
                        `${tag(event.fqn)} ${blue(event.message)}`,
                      );
                    }
                    const id = event.fqn;
                    const mode = modeSuffix({
                      mode: event.providerMode,
                      priorMode: event.fromProviderMode,
                      defaultMode: plan.defaultMode,
                    });
                    if (!isTerminal(event.status)) {
                      if (!isActive(event.status)) return Effect.void;
                      if (!started.has(id)) started.set(id, now);
                      return Effect.logInfo(
                        `${tag(id)} ${dim(event.status)}${mode}`,
                      );
                    }
                    terminal.set(id, event.status);
                    const status = statusColor(event.status)(event.status);
                    const from = started.get(id);
                    const took =
                      from === undefined
                        ? ""
                        : ` ${dim(`(${formatElapsed(now - from)})`)}`;
                    const message = event.message ?? statusNotes.get(event.fqn);
                    // Failures carry their error as the message — paint it
                    // red so the line reads as the error line for that
                    // resource, without waiting for the final cause dump.
                    const msg = message
                      ? ` ${dim("—")} ${event.status === "fail" ? red(message) : message}`
                      : "";
                    return Effect.logInfo(
                      `${tag(id)} ${status}${mode}${msg}${took}`,
                    );
                  }),
                ),
              ),
            done: (outcome) =>
              Clock.currentTimeMillis.pipe(
                Effect.flatMap((now) => {
                  const statuses = [...terminal.values()];
                  const failed = statuses.filter((s) => s === "fail").length;
                  const skipped = statuses.filter(
                    (s) => s === "skipped",
                  ).length;
                  const succeeded = terminal.size - failed - skipped;
                  const parts = [green(`${succeeded} succeeded`)];
                  if (failed) parts.push(red(`${failed} failed`));
                  if (skipped) parts.push(dim(`${skipped} skipped`));
                  return Effect.logInfo("").pipe(
                    Effect.andThen(
                      Effect.logInfo(
                        `${bold(outcome === "success" ? "Done:" : "Failed:")} ${parts.join(dim(", "))} ${dim(`(${formatElapsed(now - startedAt)})`)}`,
                      ),
                    ),
                  );
                }),
              ),
          };
        }),
    });
  }),
);
