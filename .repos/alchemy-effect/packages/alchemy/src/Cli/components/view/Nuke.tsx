/** @jsxImportSource react */
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { Result as NukeResult, Target } from "../../../Nuke.ts";
import type { ProviderMode } from "../../../ProviderMode.ts";
import { Plan, PlanTree } from "./PlanView.tsx";
import type { PlanTreeData } from "./PlanTree.ts";
import { planDecisionScreen } from "./PlanDecision.tsx";
import { Progress, type ProgressEvent } from "../../../Report.ts";
import { CliKit } from "../../CliKit/index.ts";
import {
  LiveStore,
  ProgressBar,
  Row,
  SpinnerGlyph,
  Stack,
  Text,
  useLiveStore,
} from "../ui/index.ts";

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

  emit(event: ProgressEvent) {
    this.update((state) => {
      switch (event._tag) {
        case "nuke.scan.started":
          return { ...state, total: event.total };
        case "nuke.scan.provider.started":
          return { ...state, inFlight: [...state.inFlight, event.provider] };
        case "nuke.scan.provider.completed":
          return {
            ...state,
            completed: state.completed + 1,
            resources: state.resources + event.resources,
            inFlight: state.inFlight.filter((id) => id !== event.provider),
          };
        default:
          return state;
      }
    });
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

const logNukeEvent = (event: ProgressEvent, interactive: boolean) => {
  if (event._tag === "nuke.scan.provider.completed") {
    if (event.error !== undefined)
      return Effect.logWarning(`${event.provider}: ${event.error}`);
    if (!interactive)
      return Effect.logInfo(`scanned ${event.provider} (${event.resources})`);
  } else if (event._tag === "nuke.resource.failed") {
    return Effect.logWarning(
      `${event.provider} ${event.resource}: ${event.message}`,
    );
  } else if (!interactive && event._tag === "nuke.resource.deleted") {
    return Effect.logInfo(`deleted ${event.provider} ${event.resource}`);
  }
  return Effect.void;
};

/** Scan progress stays separate until the inventory is ready to review. */
export const renderNukeScan =
  () =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const cli = yield* CliKit;
      const store = new NukeProgressStore();
      const live =
        cli.terminal.input && !process.env.DEBUG
          ? yield* cli.live.open(<NukeProgress store={store} />)
          : undefined;
      return yield* effect.pipe(
        Effect.provideService(Progress, (event) =>
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
    targets: ReadonlyArray<Pick<Target, "providerId" | "displayName">>,
    mode: ProviderMode,
  ) =>
  <A extends NukeResult, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const cli = yield* CliKit;
      const tree = new PlanTree(nukePlan(targets, { mode }), {
        mode: "apply",
        label: "Deleting resources",
        busy: true,
      });
      const live =
        cli.terminal.input && !process.env.DEBUG
          ? yield* cli.live.open(<Plan tree={tree} />, { persistOnClose: true })
          : undefined;
      return yield* effect.pipe(
        Effect.provideService(Progress, (event) =>
          Effect.gen(function* () {
            if (
              event._tag === "apply.resource.status" ||
              event._tag === "apply.resource.note"
            )
              tree.emit(event);
            else if (event._tag === "nuke.pass.started")
              tree.setLabel(`Deleting resources · pass ${event.pass}`);
            yield* logNukeEvent(event, live !== undefined);
          }),
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
  targets: ReadonlyArray<Pick<Target, "providerId" | "displayName">>,
  options: { mode: ProviderMode },
): PlanTreeData => {
  return {
    defaultMode: options.mode,
    rows: targets
      .map((target, index) => ({
        key: `nuke/${index}`,
        type: "resource" as const,
        id: target.providerId,
        resourceType: target.providerId,
        detail:
          target.displayName && target.displayName !== "unknown"
            ? target.displayName
            : undefined,
        depth: 0,
        action: "delete" as const,
        providerMode: options.mode,
      }))
      .sort(
        (a, b) =>
          a.id.localeCompare(b.id) ||
          (a.detail ?? "").localeCompare(b.detail ?? ""),
      ),
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
  };
};

export const reviewNuke = Effect.fn(function* (
  targets: ReadonlyArray<Pick<Target, "providerId" | "displayName">>,
  options: {
    mode: ProviderMode;
    yes: boolean;
    dryRun: boolean;
  },
) {
  const cli = yield* CliKit;
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
  return yield* cli.prompt.custom(
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
