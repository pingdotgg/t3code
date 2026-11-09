/** @jsxRuntime automatic */
/** @jsxImportSource @alchemy.run/sigil */
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as LogLevel from "effect/LogLevel";
import * as Match from "effect/Match";
import { onEvent, type Event } from "../../../Events.ts";
import { Interaction } from "../../../Interaction.ts";
import type { Result as NukeResult, Target } from "../../../Nuke.ts";
import type { ProviderMode } from "../../../ProviderMode.ts";
import { currentConsoleSettings } from "../../GlobalLog.ts";
import { present } from "../../Present.ts";
import {
  LiveStore,
  ProgressBar,
  Row,
  SpinnerGlyph,
  Stack,
  Text,
  useLiveStore,
} from "../ui/index.ts";
import { planDecisionScreen } from "./PlanDecision.tsx";
import type { PlanTreeData } from "./PlanTree.ts";
import { Plan, PlanTree } from "./PlanView.tsx";

interface NukeProgressState {
  readonly total: number;
  readonly completed: number;
  readonly resources: number;
  readonly inFlight: ReadonlyArray<string>;
}

export class NukeProgressStore extends LiveStore<NukeProgressState> {
  constructor() {
    super({ total: 0, completed: 0, resources: 0, inFlight: [] });
  }

  emit(event: Event) {
    this.update((state) =>
      Match.value(event).pipe(
        Match.discriminators("type")({
          "nuke.scan.started": (event) => ({ ...state, total: event.total }),
          "nuke.scan.provider.started": (event) => ({
            ...state,
            inFlight: [...state.inFlight, event.provider],
          }),
          "nuke.scan.provider.completed": (event) => ({
            ...state,
            completed: state.completed + 1,
            resources: state.resources + event.resources,
            inFlight: state.inFlight.filter((id) => id !== event.provider),
          }),
        }),
        Match.orElse(() => state),
      ),
    );
  }
}

export function NukeProgress({ store }: { store: NukeProgressStore }) {
  const state = useLiveStore(store);
  return (
    <Stack paddingX={2} paddingY={1} gap={1}>
      <Row gap={2}>
        <ProgressBar
          value={state.total === 0 ? 0 : state.completed / state.total}
          width={32}
          showPercent={false}
          variant="info"
        />
        <Text bold>
          [{state.completed}/{state.total}]
        </Text>
      </Row>
      <Stack>
        <Text tone="muted">
          Scanning providers · {state.resources} resource
          {state.resources === 1 ? "" : "s"} found
        </Text>
        {state.inFlight.slice(0, 10).map((id) => (
          <Row key={id} gap={1}>
            <SpinnerGlyph />
            <Text>Scanning {id}</Text>
          </Row>
        ))}
        {state.inFlight.length > 10 ? (
          <Text tone="muted">…and {state.inFlight.length - 10} more</Text>
        ) : null}
        {state.total === 0 ? (
          <Row gap={1}>
            <SpinnerGlyph />
            <Text>Discovering providers</Text>
          </Row>
        ) : null}
      </Stack>
    </Stack>
  );
}

const logNukeEvent = (event: Event, interactive: boolean) =>
  Match.value(event).pipe(
    Match.discriminators("type")({
      "nuke.scan.provider.completed": (event) =>
        event.error !== undefined
          ? present(`${event.provider}: ${event.error}`, { level: "Warn" })
          : interactive
            ? Effect.void
            : present(`scanned ${event.provider} (${event.resources})`),
      "nuke.resource.failed": (event) =>
        present(`${event.provider} ${event.resource}: ${event.message}`, { level: "Warn" }),
      "nuke.resource.deleted": (event) =>
        interactive ? Effect.void : present(`deleted ${event.provider} ${event.resource}`),
    }),
    Match.orElse(() => Effect.void),
  );

/** Scan progress stays separate until the inventory is ready to review. */
/**
 * `--log-level debug` (or lower) streams debug records to the console; the
 * live progress view would repaint over them, so it falls back to plain lines.
 */
const debugConsole = Effect.map(currentConsoleSettings, ({ floor }) =>
  LogLevel.isLessThan(floor, "Info"),
);

export const renderNukeScan =
  () =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const cli = yield* Interaction;
      const store = new NukeProgressStore();
      const live =
        cli.terminal.input && !(yield* debugConsole)
          ? yield* cli.live(<NukeProgress store={store} />)
          : undefined;
      return yield* effect.pipe(
        onEvent((event) =>
          Effect.gen(function* () {
            if (live) store.emit(event);
            yield* logNukeEvent(event, live !== undefined);
          }),
        ),
        Effect.ensuring(live?.close ?? Effect.void),
      );
    });

/** Drive the same resource rows used by the preview through their deletion lifecycle. */
export const renderNukeDelete =
  (
    targets: ReadonlyArray<Pick<Target, "key" | "providerId" | "displayName">>,
    mode: ProviderMode,
  ) =>
  <A extends NukeResult, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const cli = yield* Interaction;
      const tree = new PlanTree(nukePlan(targets, { mode }), {
        mode: "apply",
        label: "Deleting resources",
        busy: true,
      });
      const live =
        cli.terminal.input && !(yield* debugConsole)
          ? yield* cli.live(<Plan tree={tree} />, { persistOnClose: true })
          : undefined;
      return yield* effect.pipe(
        onEvent((event) =>
          Effect.sync(() =>
            Match.value(event).pipe(
              Match.discriminators("type")({
                "apply.resource.status": (event) => tree.emit(event),
                "apply.resource.note": (event) => tree.emit(event),
                "nuke.pass.started": (event) =>
                  tree.setLabel(`Deleting resources · pass ${event.pass}`),
              }),
              Match.orElse(() => undefined),
            ),
          ).pipe(Effect.andThen(logNukeEvent(event, live !== undefined))),
        ),
        Effect.onExit((exit) =>
          Effect.sync(() => {
            const success =
              Exit.isSuccess(exit) &&
              exit.value.failed.length === 0 &&
              exit.value.held.length === 0;
            tree.finish(
              success ? "success" : "failure",
              success ? "Nuke complete" : "Nuke incomplete",
            );
            tree.setViewport("full");
          }),
        ),
        Effect.ensuring(live?.close ?? Effect.void),
      );
    });

/** Cloud inventory rows carry display identity only, never fabricated stack state. */
export const nukePlan = (
  targets: ReadonlyArray<Pick<Target, "key" | "providerId" | "displayName">>,
  options: { mode: ProviderMode },
): PlanTreeData => ({
  defaultMode: options.mode,
  rows: targets
    .map((target) => ({
      key: target.key,
      type: "resource" as const,
      id: target.providerId,
      resourceType: target.providerId,
      detail:
        target.displayName && target.displayName !== "unknown" ? target.displayName : undefined,
      depth: 0,
      action: "delete" as const,
      providerMode: options.mode,
    }))
    .sort((a, b) => a.id.localeCompare(b.id) || (a.detail ?? "").localeCompare(b.detail ?? "")),
  summary: {
    counts: {
      create: 0,
      update: 0,
      adopted: 0,
      delete: targets.length,
      orphaned: 0,
      replace: 0,
      noop: 0,
    },
    taskCounts: { run: 0, delete: 0, noop: 0 },
    bindingChanges: 0,
  },
});

export const reviewNuke = Effect.fn(function* (
  targets: ReadonlyArray<Pick<Target, "key" | "providerId" | "displayName">>,
  options: {
    mode: ProviderMode;
    yes: boolean;
    dryRun: boolean;
  },
) {
  const cli = yield* Interaction;
  const plan = nukePlan(targets, options);
  if (options.yes || options.dryRun) {
    yield* cli.output.print(
      <Plan
        tree={
          new PlanTree(plan, {
            mode: "review",
            label: "Nuke",
            viewport: "full",
          })
        }
      />,
    );
    return true;
  }
  return yield* cli.prompt.screen(
    planDecisionScreen({
      plan,
      label: "Nuke",
      message: `Permanently DELETE ${targets.length} ${options.mode === "local" ? "locally emulated " : ""}resource(s)? This cannot be undone.`,
      choices: [
        { value: true, label: "Delete" },
        { value: false, label: "Cancel" },
      ],
      initialValue: false,
    }),
  );
});
