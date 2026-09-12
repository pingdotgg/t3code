/** @jsxImportSource react */
/**
 * GUI-style dashboard behind bare `alchemy profile`. One Sigil app stays
 * mounted for the whole session and screens replace each other in place:
 *
 *   overview — chip tabs (default profile first), selected profile's
 *              provider details with an up/down focus cursor, keybind bar,
 *              inline rename/new/delete/remove
 *   edit     — replaces the overview: per-provider cycle rows
 *              (keep / reconfigure / remove, add for unconnected)
 *
 * Pure store actions (create/rename/delete) round-trip through
 * the hub via a request bridge WITHOUT unmounting — results come back as
 * in-app notices. Only flows that must prompt in the transcript (provider
 * configuration, credential refresh) resolve the session. The built-in
 * `default` profile is pinned first and can be neither renamed nor deleted.
 */
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scheduler from "effect/Scheduler";
import { type JSX, useEffect, useState } from "react";
import {
  Alert,
  Box,
  CycleList,
  Gutter,
  InlineConfirm,
  KeyBar,
  LiveStore,
  Pointer,
  PromptFrame,
  Spinner,
  Stack,
  Status,
  Tabs,
  Text,
  TextField,
  Toast,
  useCycleNavigation,
  useGlyphs,
  useKeyGlyphs,
  useLiveStore,
  useTerminalInput,
  useTerminalSize,
  VirtualList,
} from "../ui/index.ts";
import {
  CliKit,
  theme,
  type NonInteractiveTerminal,
} from "../../CliKit/index.ts";
import {
  type EditState,
  editStateStyle,
  ProviderBlock,
  providerBlockHeight,
  providerColumnWidths,
  type ProfileProviderDisplay,
} from "./Profile.tsx";

// --- data contracts ---------------------------------------------------------

export interface DashboardEntry {
  readonly name: string;
  readonly isActive: boolean;
  readonly isDefault: boolean;
}

export interface ProfileDetailsPayload {
  readonly providers: ReadonlyArray<ProfileProviderDisplay>;
  /** Registry providers not yet connected to this profile. */
  readonly available: ReadonlyArray<string>;
}

export type PureAction =
  | { kind: "create"; name: string }
  | { kind: "rename"; name: string; newName: string }
  | { kind: "delete"; name: string };

export type FlowAction =
  | {
      kind: "edit-apply";
      name: string;
      add: string[];
      reconfigure: string[];
      remove: string[];
    }
  | { kind: "refresh"; name: string; provider?: string };

export type ExternalAction = FlowAction | { kind: "exit" };

export interface ExecuteResult {
  readonly ok: boolean;
  readonly message: string;
  readonly entries: ReadonlyArray<DashboardEntry>;
  /** Profile to focus after the action (e.g. the new name of a rename). */
  readonly selected?: string;
}

// --- store ------------------------------------------------------------------

export type Details =
  | { state: "loading" }
  | ({ state: "ready" } & ProfileDetailsPayload)
  | { state: "failed"; message: string };

interface Notice {
  readonly ok: boolean;
  readonly message: string;
}

interface Flow {
  readonly kind: FlowAction["kind"];
  readonly name: string;
  readonly provider?: string;
  /** Inline flows render within the overview (refresh spinner). */
  readonly inline: boolean;
}

interface DashState {
  readonly entries: ReadonlyArray<DashboardEntry>;
  readonly details: ReadonlyMap<string, Details>;
  readonly notice: Notice | undefined;
  readonly busy: boolean;
  /** One-shot tab focus request (e.g. follow a rename to its new name). */
  readonly focus: string | undefined;
  /** Active in-app flow; `inline` flows render within the overview. */
  readonly flow: Flow | undefined;
}

/**
 * Immutable-snapshot store on top of `LiveStore`, so every mutation notifies
 * the mounted dashboard. The resolver bridge and the notice auto-dismiss
 * timer live outside the snapshot — they carry no visual state.
 */
export class DashStore extends LiveStore<DashState> {
  private resolver: ((action: PureAction | ExternalAction) => void) | null =
    null;

  constructor(entries: ReadonlyArray<DashboardEntry>) {
    super({
      entries,
      details: new Map(),
      notice: undefined,
      busy: false,
      focus: undefined,
      flow: undefined,
    });
  }

  detailsFor(name: string): Details {
    return this.snapshot().details.get(name) ?? { state: "loading" };
  }
  detailNames(): ReadonlySet<string> {
    return new Set(this.snapshot().details.keys());
  }
  setDetails(name: string, details: Details) {
    this.update((state) => ({
      ...state,
      details: new Map(state.details).set(name, details),
    }));
  }
  setFlow(flow: Flow | undefined) {
    this.update((state) => ({ ...state, flow }));
  }
  clearFocus() {
    this.update((state) => ({ ...state, focus: undefined }));
  }
  dispose() {
    this.resolver = null;
  }
  clearNotice() {
    this.update((state) => ({ ...state, notice: undefined }));
  }
  applyResult(result: ExecuteResult) {
    this.update((state) => ({
      ...state,
      entries: result.entries,
      notice: { ok: result.ok, message: result.message },
      focus: result.ok ? result.selected : undefined,
      busy: false,
    }));
  }
  bindResolver(resolve: (action: PureAction | ExternalAction) => void) {
    this.resolver = resolve;
  }
  readonly dispatch = (action: PureAction | ExternalAction) => {
    if (this.snapshot().busy || this.resolver === null) return;
    const resolve = this.resolver;
    this.resolver = null;
    this.update((state) => ({ ...state, busy: true, notice: undefined }));
    resolve(action);
  };
}

// --- building blocks --------------------------------------------------------

type DetailsPaneProps = {
  details: Details;
  refreshingProvider?: string;
  /** Index into `details.providers` the up/down cursor rests on. */
  focusedIndex: number;
};

function DetailsPane({
  details,
  refreshingProvider,
  focusedIndex,
}: DetailsPaneProps): JSX.Element {
  if (details.state === "loading") {
    return <Spinner label="resolving credentials…" />;
  }
  if (details.state === "failed") {
    return <Status variant="error">{details.message}</Status>;
  }
  if (details.providers.length === 0) {
    return (
      <Text tone="muted">No accounts connected — press e to add one.</Text>
    );
  }
  const { providers } = details;
  const { nameWidth, methodWidth } = providerColumnWidths(providers);
  const focusedProvider = providers[focusedIndex]?.name;
  const reauthHint = "press r to re-login";
  // The same blocks `profile show` prints, windowed to the rows the terminal
  // leaves the pane: the list shrinks to fit (see the root layout in
  // `Dashboard`) and scrolls just enough to keep the focused provider in view.
  // The profile-level slot (no focused provider) shows the list from the top.
  return (
    <Box flexDirection="column" minHeight={0}>
      <VirtualList
        items={providers}
        getKey={(provider) => provider.name}
        itemHeight={(provider, index) =>
          providerBlockHeight(provider, index === 0)
        }
        focusedIndex={Math.max(0, focusedIndex)}
        renderItem={(provider, index) => (
          <ProviderBlock
            provider={provider}
            first={index === 0}
            nameWidth={nameWidth}
            methodWidth={methodWidth}
            reauthHint={reauthHint}
            refreshingProvider={refreshingProvider}
            focusedProvider={focusedProvider}
            focusColumn
          />
        )}
      />
    </Box>
  );
}

// --- edit screen ------------------------------------------------------------

interface EditRow {
  readonly provider: string;
  readonly method: string | undefined; // undefined = not connected
  readonly states: ReadonlyArray<EditState>;
}

type EditScreenProps = {
  profile: string;
  rows: ReadonlyArray<EditRow>;
  onApply: (choices: ReadonlyArray<EditState>) => void;
  onBack: () => void;
};

function EditScreen({
  profile,
  rows,
  onApply,
  onBack,
}: EditScreenProps): JSX.Element {
  const { cursor, indices, move, cycle } = useCycleNavigation(
    rows.map((row) => row.states.length),
  );
  const keys = useKeyGlyphs();
  const glyphs = useGlyphs();
  const [unchanged, setUnchanged] = useState(false);
  useTerminalInput((input, key) => {
    const plain = !key.ctrl && !key.meta;
    if (key.escape) return onBack();
    if (key.up || (plain && input === "k")) move(-1);
    else if (key.down || (plain && input === "j")) move(1);
    else if ((plain && input === " ") || key.right) {
      cycle(1);
      setUnchanged(false);
    } else if (key.left) {
      cycle(-1);
      setUnchanged(false);
    } else if (key.enter) {
      if (indices.every((index) => index === 0)) setUnchanged(true);
      else onApply(rows.map((row, i) => row.states[indices[i]]!));
    }
  });
  if (rows.length === 0) {
    return (
      <Stack>
        <Text>
          <Text bold color={theme.color.accent}>
            edit accounts
          </Text>
          <Text tone="muted"> · {profile}</Text>
        </Text>
        <Status>No providers are available for this profile.</Status>
        <KeyBar keys={[[keys.escape, "back"]]} />
      </Stack>
    );
  }
  const choices = rows.map((row) => ({
    label: row.provider,
    description: row.method ?? "not connected",
    states: row.states.map((state) => ({
      value: state,
      label: editStateStyle[state].label,
      icon: glyphs[editStateStyle[state].icon],
      variant: editStateStyle[state].variant,
    })),
  }));
  return (
    <Stack gap={1}>
      <Text>
        <Text bold color={theme.color.accent}>
          edit accounts
        </Text>
        <Text tone="muted"> · {profile}</Text>
      </Text>
      <CycleList choices={choices} cursor={cursor} indices={indices} />
      {unchanged ? (
        <Alert variant="warning" title="No changes to apply">
          Press Space to change an account, or Esc to go back.
        </Alert>
      ) : null}
      <KeyBar
        keys={[
          [keys.upDown, "navigate"],
          [keys.space, "change"],
          [keys.enter, "apply"],
          [keys.escape, "back"],
        ]}
      />
    </Stack>
  );
}

// --- main component ---------------------------------------------------------

type Mode = "normal" | "rename" | "create" | "delete" | "remove";

type DashboardControlsProps = {
  readonly mode: Mode;
  readonly busy: boolean;
  readonly flow: Flow | undefined;
  readonly entry: DashboardEntry | undefined;
  readonly provider: ProfileProviderDisplay | undefined;
  readonly keybinds: ReadonlyArray<readonly [string, string]>;
  readonly keyGlyphs: ReturnType<typeof useKeyGlyphs>;
  readonly store: DashStore;
  readonly setMode: (mode: Mode) => void;
};

function DashboardControls({
  mode,
  busy,
  flow,
  entry,
  provider,
  keybinds,
  keyGlyphs,
  store,
  setMode,
}: DashboardControlsProps) {
  if (flow?.inline !== true && (busy || flow !== undefined)) return null;
  if (mode === "normal") return <KeyBar keys={keybinds} marginTop={0} />;
  if (mode === "delete" && entry !== undefined) {
    return (
      <InlineConfirm
        message={`Delete '${entry.name}' and all its stored credentials?`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onSubmit={(confirmed) => {
          setMode("normal");
          if (confirmed) store.dispatch({ kind: "delete", name: entry.name });
        }}
        onCancel={() => setMode("normal")}
      />
    );
  }
  if (mode === "remove" && entry !== undefined && provider !== undefined) {
    return (
      <InlineConfirm
        message={`Remove '${provider.name}' from profile '${entry.name}'?`}
        confirmLabel="Remove"
        cancelLabel="Cancel"
        onSubmit={(confirmed) => {
          setMode("normal");
          if (confirmed) {
            store.dispatch({
              kind: "edit-apply",
              name: entry.name,
              add: [],
              reconfigure: [],
              remove: [provider.name],
            });
          }
        }}
        onCancel={() => setMode("normal")}
      />
    );
  }

  const renaming = mode === "rename" && entry !== undefined;
  return (
    <PromptFrame
      message={renaming ? `rename '${entry.name}' to` : "new profile name"}
      layout="inline"
      keys={[
        [keyGlyphs.enter, "confirm"],
        [keyGlyphs.escape, "cancel"],
      ]}
    >
      <TextField
        key={`${mode}-${entry?.name ?? ""}`}
        placeholder={renaming ? `${entry.name}-new` : "my-profile"}
        onSubmit={(value) => {
          const name = value.trim();
          if (name.length === 0) return;
          setMode("normal");
          store.dispatch(
            renaming
              ? { kind: "rename", name: entry.name, newName: name }
              : { kind: "create", name },
          );
        }}
        onCancel={() => setMode("normal")}
      />
    </PromptFrame>
  );
}

type DashboardProps = {
  store: DashStore;
  initialSelected: number;
};

export function Dashboard({
  store,
  initialSelected,
}: DashboardProps): JSX.Element {
  const state = useLiveStore(store);
  const keyGlyphs = useKeyGlyphs();
  const { rows } = useTerminalSize();
  const [selected, setSelected] = useState(initialSelected);
  // -1 is the profile-level slot: no provider is focused and profile actions
  // are shown. Up/down cycles through this slot and every connected provider.
  const [focusedProvider, setFocusedProvider] = useState(-1);
  const [mode, setMode] = useState<Mode>("normal");
  const [screen, setScreen] = useState<"overview" | "edit">("overview");
  const { entries, focus: requestedFocus, flow, busy, notice } = state;
  useEffect(() => {
    if (requestedFocus === undefined) return;
    const focusIndex = entries.findIndex(
      (entry) => entry.name === requestedFocus,
    );
    store.clearFocus();
    if (focusIndex >= 0) {
      setSelected(focusIndex);
    }
  }, [entries, requestedFocus, store]);
  const index = Math.min(Math.max(selected, 0), entries.length - 1);
  const entry = entries[index];
  const details =
    entry === undefined ? undefined : store.detailsFor(entry.name);
  const providers = details?.state === "ready" ? details.providers : [];
  const provider = providers[focusedProvider];
  const moveProviderFocus = (delta: -1 | 1) =>
    setFocusedProvider((current) => {
      const slotCount = providers.length + 1;
      const position = current + 1;
      return ((position + delta + slotCount) % slotCount) - 1;
    });
  useEffect(() => setFocusedProvider(-1), [entry?.name]);

  useTerminalInput((input, key) => {
    // flow prompts, the edit screen, and the inline TextField/InlineConfirm
    // modes own the keyboard
    if (flow !== undefined || screen === "edit" || busy) return;
    if (mode !== "normal") return;
    if (input === "q" || key.escape || (key.ctrl && input === "c")) {
      store.dispatch({ kind: "exit" });
    } else if (key.ctrl || key.meta) {
      return;
    } else if (entry === undefined) {
      if (input === "n") setMode("create");
    } else if (key.left) {
      setSelected((s) => (s + entries.length - 1) % entries.length);
      setFocusedProvider(-1);
    } else if (key.right) {
      setSelected((s) => (s + 1) % entries.length);
      setFocusedProvider(-1);
    } else if (key.up && providers.length > 0) {
      moveProviderFocus(-1);
    } else if (key.down && providers.length > 0) {
      moveProviderFocus(1);
    } else if (provider === undefined && input === "R" && !entry.isDefault) {
      setMode("rename");
    } else if (provider === undefined && input === "d" && !entry.isDefault) {
      setMode("delete");
    } else if (
      provider === undefined &&
      input === "e" &&
      details?.state === "ready"
    ) {
      setScreen("edit");
    } else if (provider === undefined && input === "r") {
      store.dispatch({ kind: "refresh", name: entry.name });
    } else if (provider === undefined && input === "n") {
      setMode("create");
    } else if (input === "e" && provider !== undefined) {
      store.dispatch({
        kind: "edit-apply",
        name: entry.name,
        add: [],
        reconfigure: [provider.name],
        remove: [],
      });
    } else if (input === "r" && provider !== undefined) {
      store.dispatch({
        kind: "refresh",
        name: entry.name,
        provider: provider.name,
      });
    } else if (input === "d" && provider !== undefined) {
      setMode("remove");
    }
  });

  if (flow !== undefined && !flow.inline) {
    return (
      <Text>
        <Text bold color={theme.color.accent}>
          {flow.kind === "refresh" ? "refresh" : "edit accounts"}
        </Text>
        <Text tone="muted"> · {flow.name}</Text>
      </Text>
    );
  }

  if (
    screen === "edit" &&
    entry !== undefined &&
    details !== undefined &&
    details.state === "ready"
  ) {
    const rows: EditRow[] = [
      ...details.providers.map((provider) => ({
        provider: provider.name,
        method: provider.method,
        states: ["keep", "reconfigure", "remove"] as const,
      })),
      ...details.available.map((name) => ({
        provider: name,
        method: undefined,
        states: ["skip", "add"] as const,
      })),
    ];
    return (
      <EditScreen
        profile={entry.name}
        rows={rows}
        onBack={() => setScreen("overview")}
        onApply={(choices) => {
          const pick = (state: EditState) =>
            rows.flatMap((row, i) =>
              choices[i] === state ? [row.provider] : [],
            );
          const action: ExternalAction = {
            kind: "edit-apply",
            name: entry.name,
            add: pick("add"),
            reconfigure: pick("reconfigure"),
            remove: pick("remove"),
          };
          setScreen("overview");
          if (
            action.add.length +
              action.reconfigure.length +
              action.remove.length ===
            0
          ) {
            return;
          }
          store.dispatch(action);
        }}
      />
    );
  }

  const annotation = entry !== undefined && entry.isActive ? "active" : "";

  const keybinds: ReadonlyArray<readonly [string, string]> =
    entry === undefined
      ? [
          ["n", "new"],
          ["q", "quit"],
        ]
      : [
          [keyGlyphs.leftRight, "switch profile"],
          ...(providers.length === 0
            ? []
            : ([[keyGlyphs.upDown, "focus provider"]] as const)),
          ...(provider !== undefined
            ? ([
                ["e", "reconfigure"],
                ["r", "refresh"],
                ["d", "remove"],
              ] as const)
            : ([
                ...(details?.state === "ready"
                  ? ([
                      ["e", "edit"],
                      ["r", "refresh"],
                    ] as const)
                  : []),
                ["n", "new"],
                ...(entry.isDefault
                  ? []
                  : ([
                      ["R", "rename"],
                      ["d", "delete"],
                    ] as const)),
              ] as ReadonlyArray<readonly [string, string]>)),
          ["q", "quit"],
        ];

  // The frame never exceeds the terminal: the provider list is the only part
  // allowed to shrink (a `VirtualList` windows it to whatever rows are left),
  // so every other row of chrome opts out of shrinking. Short lists keep the
  // compact layout because the cap is a maximum, not a fixed height.
  return (
    <Stack maxHeight={rows}>
      <Stack flexShrink={0}>
        <Tabs
          tabs={entries.map((e) => ({
            id: e.name,
            label: e.name,
            marked: e.isActive,
          }))}
          active={entry?.name ?? ""}
        />
      </Stack>
      <Stack gap={1} minHeight={0}>
        {entry === undefined ? (
          <Text tone="muted">No profiles yet — press n to create one.</Text>
        ) : (
          <>
            {/* The profile row is the first focus slot. It sits in the same
                gutter as the provider rows and shares their cursor column, so
                the pointer moves in a straight line as focus travels. */}
            <Box flexShrink={0}>
              <Gutter>
                <Box flexDirection="row">
                  <Pointer focused={provider === undefined} />
                  <Text> </Text>
                  <Text
                    bold
                    color={
                      provider === undefined ? theme.paint.focus : undefined
                    }
                  >
                    {entry.name}
                  </Text>
                  {annotation === "" ? null : (
                    <Text tone="muted"> · {annotation}</Text>
                  )}
                </Box>
              </Gutter>
            </Box>
            <Box flexDirection="column" minHeight={0}>
              <DetailsPane
                details={details ?? { state: "loading" }}
                focusedIndex={focusedProvider}
                refreshingProvider={
                  flow?.kind === "refresh" ? flow.provider : undefined
                }
              />
            </Box>
          </>
        )}
      </Stack>
      {/* Keep one stable status row so notices do not push the controls around.
          It shares the gutter with the profile/provider rows above it. */}
      <Box minHeight={1} flexShrink={0} paddingLeft={theme.space.indent}>
        {busy && flow === undefined ? (
          <Spinner label="working…" />
        ) : notice !== undefined ? (
          <Toast variant={notice.ok ? "info" : "error"}>{notice.message}</Toast>
        ) : null}
      </Box>
      <Stack flexShrink={0}>
        <DashboardControls
          mode={mode}
          busy={busy}
          flow={flow}
          entry={entry}
          provider={provider}
          keybinds={keybinds}
          keyGlyphs={keyGlyphs}
          store={store}
          setMode={setMode}
        />
      </Stack>
    </Stack>
  );
}

// --- session driver ---------------------------------------------------------

export interface DashboardSessionOptions<R> {
  readonly entries: ReadonlyArray<DashboardEntry>;
  readonly selected: string | undefined;
  /**
   * Resolves a profile's provider details. A typed failure renders as the
   * detail pane's `failed` state, showing the error's message.
   */
  readonly loadDetails: (
    name: string,
  ) => Effect.Effect<ProfileDetailsPayload, { readonly message: string }, R>;
  /** Executes a pure store action and returns the refreshed state. */
  readonly execute: (
    action: PureAction,
  ) => Effect.Effect<ExecuteResult, never, R>;
  /**
   * Runs an edit/refresh flow. Its prompts render inside the dashboard via
   * the embedded session; resolves with a toast outcome — `ok: false`
   * renders as a persistent error notice instead of an auto-dismissing
   * success toast.
   */
  readonly runFlow: (
    action: FlowAction,
    events: {
      readonly onProviderStart: (provider: string) => Effect.Effect<void>;
    },
  ) => Effect.Effect<{ ok: boolean; message: string }, never, R>;
  /** Re-reads entries after a flow (the active profile may have changed). */
  readonly reloadEntries: Effect.Effect<
    ReadonlyArray<DashboardEntry>,
    never,
    R
  >;
}

/**
 * Runs the dashboard inside CliKit's application renderer. Pure actions and
 * edit/refresh flows share the same frame, and the application clears it on
 * exit.
 */
export const runProfileDashboardSession = <R,>(
  options: DashboardSessionOptions<R>,
): Effect.Effect<void, NonInteractiveTerminal, R | CliKit> =>
  Effect.flatMap(CliKit, (cli) =>
    cli.application(
      // live.open is Scope-bound; the session scope is its release backstop
      // (the ensuring(live.close) below settles it on the normal path).
      Effect.scoped(
        Effect.gen(function* () {
          const store = new DashStore(options.entries);
          let noticeFiber: Fiber.Fiber<void, never> | undefined;

          const applyResult = Effect.fn(function* (result: ExecuteResult) {
            if (noticeFiber !== undefined) yield* Fiber.interrupt(noticeFiber);
            store.applyResult(result);
            if (result.ok) {
              noticeFiber = yield* Effect.sleep("4 seconds").pipe(
                Effect.andThen(Effect.sync(() => store.clearNotice())),
                Effect.forkChild,
              );
            }
          });

          const loadInto = (name: string) =>
            options.loadDetails(name).pipe(
              Effect.flatMap((payload) =>
                Effect.sync(() =>
                  store.setDetails(name, { state: "ready", ...payload }),
                ),
              ),
              Effect.catch((error) =>
                Effect.sync(() =>
                  store.setDetails(name, {
                    state: "failed",
                    message: error.message,
                  }),
                ),
              ),
              Effect.catchDefect((defect) =>
                Effect.sync(() =>
                  store.setDetails(name, {
                    state: "failed",
                    message: String(defect),
                  }),
                ),
              ),
              // Provider discovery can build very large Layers. Yield often
              // enough for Sigil's 80ms animation clock to keep painting while
              // that CPU-heavy Effect graph is evaluated.
              Effect.provideService(Scheduler.MaxOpsBeforeYield, 64),
            );

          const initialSelected = Math.max(
            0,
            options.entries.findIndex(
              (entry) => entry.name === options.selected,
            ),
          );

          const live = yield* cli.live.open(
            <Dashboard store={store} initialSelected={initialSelected} />,
            { placement: "beforeTranscript" },
          );

          // Mount the spinner before starting stack import/provider builds.
          // Forking the loader first allowed synchronous module evaluation to
          // delay the dashboard's first frame, making it look fully hung.
          const loader = yield* Effect.forEach(
            options.entries,
            (entry) => loadInto(entry.name),
            { concurrency: 2, discard: true },
          ).pipe(Effect.delay("1 millis"), Effect.forkChild);

          yield* Effect.gen(function* () {
            while (true) {
              const action = yield* Effect.callback<
                PureAction | ExternalAction
              >((resume) => {
                store.bindResolver((action) => resume(Effect.succeed(action)));
              });
              switch (action.kind) {
                case "exit":
                  return;
                case "refresh":
                case "edit-apply": {
                  store.setFlow({
                    kind: action.kind,
                    name: action.name,
                    provider:
                      action.kind === "refresh" ? action.provider : undefined,
                    // refresh keeps the overview on screen with a spinner; only
                    // account editing takes over the whole view
                    inline: action.kind === "refresh",
                  });
                  const flowEffect = options.runFlow(action, {
                    onProviderStart: (provider) =>
                      Effect.sync(() =>
                        store.setFlow({
                          kind: "refresh",
                          name: action.name,
                          provider,
                          inline: true,
                        }),
                      ),
                  });
                  // Provider login implementations emit useful progress in
                  // standalone commands. Inside the dashboard that progress
                  // belongs in the provider pane, not the transcript.
                  const quietRefreshCli = {
                    ...cli,
                    output: {
                      ...cli.output,
                      info: () => Effect.void,
                      success: () => Effect.void,
                    },
                  } satisfies CliKit["Service"];
                  const result = yield* cli.wizard(
                    action.kind === "refresh"
                      ? flowEffect.pipe(
                          Effect.provideService(CliKit, quietRefreshCli),
                        )
                      : flowEffect,
                  );
                  const entries = yield* options.reloadEntries;
                  if (action.kind === "refresh") {
                    // Keep the provider-level spinner visible until the new
                    // expiry/token details have replaced the old ones.
                    yield* loadInto(action.name);
                  } else {
                    store.setDetails(action.name, { state: "loading" });
                    yield* loadInto(action.name).pipe(Effect.forkChild);
                  }
                  store.setFlow(undefined);
                  yield* applyResult({
                    ok: result.ok,
                    message: result.message,
                    entries,
                    selected: action.name,
                  });
                  break;
                }
                default: {
                  const result = yield* options.execute(action);
                  // a renamed/created profile needs its details (re)resolved
                  const names = store.detailNames();
                  yield* applyResult(result);
                  yield* Effect.forEach(
                    result.entries.filter((e) => !names.has(e.name)),
                    (e) => loadInto(e.name),
                    { concurrency: 2, discard: true },
                  ).pipe(Effect.forkChild);
                }
              }
            }
          }).pipe(
            Effect.ensuring(Effect.sync(() => store.dispose())),
            Effect.ensuring(
              Effect.suspend(() =>
                noticeFiber === undefined
                  ? Effect.void
                  : Fiber.interrupt(noticeFiber),
              ),
            ),
            Effect.ensuring(live.close),
            Effect.ensuring(Fiber.interrupt(loader)),
          );
        }),
      ),
    ),
  );
