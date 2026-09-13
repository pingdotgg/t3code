/** @jsxImportSource react */
import { stripVTControlCharacters } from "node:util";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import {
  AnsiText,
  Box,
  render,
  renderToString,
  Static,
  useTitle,
} from "@alchemy.run/sigil";
import { type ReactNode, useSyncExternalStore } from "react";
import { Spinner, Status } from "../ui/Feedback.tsx";
import { CliEnvironment } from "../ui/Environment.tsx";
import { useTerminalInput } from "../ui/Interactive.tsx";
import { LiveStore, useLiveStore } from "../ui/Live.tsx";
import { CancelledPrompt } from "../ui/Transcript.tsx";
import { Text } from "../ui/Typography.tsx";
import {
  NonInteractiveTerminal,
  TerminalCancelled,
} from "../../../Interaction.ts";
import {
  confirmScreen,
  cycleSelectScreen,
  awaitExternalScreen,
  menuScreen,
  multiSelectScreen,
  passwordScreen,
  selectScreen,
  textScreen,
} from "./Prompts.tsx";
import { ApplicationPresentation, CliKit } from "../../CliKit/CliKit.ts";
import { setNativeProgress } from "../../../Util/Terminal.ts";
import type {
  ProgressHandle,
  ProgressOptions,
  RenderOptions,
  Screen,
  MenuOptions,
  CliKitCapabilities,
  CliKitOptions,
  InteractionError,
  LiveViewHandle,
  LiveViewOptions,
  View,
} from "../types.ts";

const InApplication = Context.Reference<boolean>(
  "Alchemy::CliKit/InApplication",
  {
    defaultValue: () => false,
  },
);

/**
 * One rendered block. Views are immutable once mounted — dynamic content
 * flows through caller-owned stores (`LiveStore` + `useLiveStore`) that the
 * view component subscribes to, never through the runtime.
 */
interface Item {
  readonly key: number;
  readonly view: View;
  readonly placement?: LiveViewOptions["placement"];
}

const normalizeView = (view: View): View => {
  if (
    typeof view === "string" ||
    typeof view === "number" ||
    typeof view === "bigint"
  ) {
    return <Text>{String(view)}</Text>;
  }
  // Contract: an array of primitives renders as ONE Text line with the
  // elements concatenated (no separator) — matching how React renders
  // adjacent text children. Callers wanting separators must join themselves.
  if (
    Array.isArray(view) &&
    view.every(
      (item) =>
        item === null ||
        item === undefined ||
        typeof item === "boolean" ||
        typeof item === "string" ||
        typeof item === "number" ||
        typeof item === "bigint",
    )
  ) {
    return (
      <Text>
        {view
          .filter(
            (item) =>
              item !== null && item !== undefined && typeof item !== "boolean",
          )
          .map(String)
          .join("")}
      </Text>
    );
  }
  return view;
};

const formatStaticView = (
  view: ReactNode,
  options: RenderOptions,
  capabilities: CliKitCapabilities,
): string => {
  const colors = options.colors ?? capabilities.colors;
  // The renderer and the components must agree on the width: components size
  // themselves from the environment's `columns`, so an explicit render width
  // has to flow into the capabilities too, not only into renderToString.
  const columns = options.columns ?? capabilities.columns;
  const output = renderToString(
    <CliEnvironment capabilities={{ ...capabilities, colors, columns }}>
      {view}
    </CliEnvironment>,
    { columns },
  ).replace(/[\s\n]+$/, "");
  return colors ? output : stripVTControlCharacters(output);
};

interface StoreState {
  readonly staticItems: Item[];
  readonly transcript: ReadonlyArray<Item>;
  readonly live: ReadonlyArray<Item>;
  readonly active?: Item;
}

/**
 * The single external store the React root syncs from. It only tracks WHICH
 * blocks are mounted and in what region (static scrollback, in-application
 * transcript, live region, active prompt) — block content never changes
 * after mount, so there is no update surface here.
 */
class TerminalStore {
  private state: StoreState = { staticItems: [], transcript: [], live: [] };
  private readonly listeners = new Set<() => void>();
  private nextKey = 0;

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  readonly snapshot = () => this.state;

  private commit(state: StoreState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  alloc() {
    return this.nextKey++;
  }

  append(view: View) {
    this.commit({
      ...this.state,
      transcript: [...this.state.transcript, { key: this.alloc(), view }],
    });
  }

  appendStatic(view: View) {
    this.commit({
      ...this.state,
      staticItems: [...this.state.staticItems, { key: this.alloc(), view }],
    });
  }

  addLive(
    key: number,
    view: View,
    placement: LiveViewOptions["placement"] = "afterTranscript",
  ) {
    this.commit({
      ...this.state,
      live: [...this.state.live, { key, view, placement }],
    });
  }

  removeLive(key: number) {
    this.commit({
      ...this.state,
      live: this.state.live.filter((entry) => entry.key !== key),
    });
  }

  /**
   * Move a live block into scrollback (its component renders one final time
   * from its store's final state). No-op when the row was already cleared.
   */
  completeLive(key: number, destination: "staticItems" | "transcript") {
    const item = this.state.live.find((entry) => entry.key === key);
    if (item === undefined) return;
    this.commit({
      ...this.state,
      [destination]: [
        ...this.state[destination],
        { key: this.alloc(), view: item.view },
      ],
      live: this.state.live.filter((entry) => entry.key !== key),
    });
  }

  activate(view: View) {
    this.commit({ ...this.state, active: { key: this.alloc(), view } });
  }

  deactivate() {
    if (this.state.active !== undefined)
      this.commit({ ...this.state, active: undefined });
  }

  clear() {
    this.commit({ ...this.state, transcript: [], live: [] });
  }

  clearStatic() {
    if (this.state.staticItems.length > 0) {
      this.commit({ ...this.state, staticItems: [] });
    }
  }

  clearTranscript() {
    if (this.state.transcript.length > 0) {
      this.commit({ ...this.state, transcript: [] });
    }
  }

  get idle() {
    return this.state.active === undefined && this.state.live.length === 0;
  }
}

/**
 * Always-on Ctrl+C handler wrapped around every screen by `run`. Screens no
 * longer need their own Ctrl+C wiring (a screen that forgot it used to make
 * the CLI unkillable, since Sigil runs with `exitOnCtrlC: false` in raw mode);
 * they only handle Escape, whose semantics differ per screen.
 */
type ScreenCancelGuardProps = {
  readonly onCancel: () => void;
  readonly children?: ReactNode;
};

function ScreenCancelGuard({ onCancel, children }: ScreenCancelGuardProps) {
  useTerminalInput(
    (input, key) => {
      if (key.ctrl && input === "c") onCancel();
    },
    { active: true },
  );
  return <>{children}</>;
}

type ItemViewProps = { readonly item: Item };

function ItemView({ item }: ItemViewProps) {
  return <Box flexDirection="column">{item.view}</Box>;
}

type TerminalRootProps = {
  readonly store: TerminalStore;
};

function TerminalRoot({ store }: TerminalRootProps) {
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  useTerminalInput(
    (input, key) => {
      if (!key.ctrl || input !== "c") return;
      process.kill(process.pid, "SIGINT");
    },
    { active: state.active === undefined },
  );
  const beforeTranscript = state.live.filter(
    (item) => item.placement === "beforeTranscript",
  );
  const afterTranscript = state.live.filter(
    (item) => item.placement !== "beforeTranscript",
  );
  return (
    <Box flexDirection="column">
      <Static items={state.staticItems}>
        {(item) => <ItemView key={item.key} item={item} />}
      </Static>
      {beforeTranscript.map((item) => (
        <ItemView key={item.key} item={item} />
      ))}
      {state.transcript.map((item) => (
        <ItemView key={item.key} item={item} />
      ))}
      {afterTranscript.map((item) => (
        <ItemView key={item.key} item={item} />
      ))}
      {state.active === undefined ? null : (
        <Box marginTop={state.transcript.length > 0 ? 1 : 0}>
          <ItemView key={state.active.key} item={state.active} />
        </Box>
      )}
    </Box>
  );
}

/** Progress rows are ordinary live views over a runtime-owned store. */
interface ProgressState {
  readonly options: ProgressOptions;
  readonly final?: {
    readonly variant: "success" | "error";
    readonly message?: string;
  };
}

type ProgressViewProps = {
  readonly store: LiveStore<ProgressState>;
};

function ProgressView({ store }: ProgressViewProps) {
  const state = useLiveStore(store);
  useTitle(state.options.title);
  return state.final !== undefined ? (
    <Status variant={state.final.variant}>
      {state.final.message ?? state.options.label}
    </Status>
  ) : state.options.spinning === false ? (
    <Status variant="info" detail={state.options.detail}>
      {state.options.label}
    </Status>
  ) : (
    <Spinner label={state.options.label} detail={state.options.detail} />
  );
}

export interface CliKitRuntime {
  readonly service: CliKit["Service"];
  readonly dispose: () => Promise<void>;
}

export const makeRuntime = (
  options: CliKitOptions,
  capabilities: CliKitCapabilities,
): CliKitRuntime => {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const store = new TerminalStore();
  const rendererGate = Semaphore.makeUnsafe(1);
  const promptGate = Semaphore.makeUnsafe(1);

  interface Mounted {
    readonly sigil: ReturnType<typeof render>;
    readonly alternate: boolean;
    /** Settles when the instance exits; render crashes are routed out, never rethrown. */
    exit: Promise<void>;
    /**
     * Flush any partial captured line into the Static transcript — called at
     * unmount so trailing output without a newline still lands. Lives on the
     * instance because it closes over this mount's capture buffers and must
     * die with it.
     */
    readonly flushDirectStdio?: () => void;
  }
  // Lifecycle state. `mounted` and `unmounting` deliberately overlap: during
  // teardown the instance stays in `mounted` until re-validation passes, so
  // prints/live views racing the drain still see a live renderer (and can
  // abort the teardown). `applicationMounted` is an orthogonal axis — an
  // `app()` region pins the renderer regardless of store idleness — and
  // `disposed` is a terminal one-way latch.
  let mounted: Mounted | undefined;
  let unmounting: Promise<void> | undefined;
  let applicationMounted = false;
  let disposed = false;
  /**
   * Fails the active interaction when a screen component throws during
   * render. Without this the prompt's callback would never resume and the
   * CLI would hang with a dead renderer.
   */
  let failActive: ((error: unknown) => void) | undefined;
  /**
   * The single failure channel for renderer errors: route into the active
   * interaction when a prompt is waiting, otherwise surface on stderr. Every
   * async failure path (the exit promise, fire-and-forget mounts) funnels
   * here so no rejection ever escapes unhandled.
   */
  const failRenderer = (error: unknown) => {
    if (failActive !== undefined) failActive(error);
    else stderr.write(`CliKit renderer error: ${String(error)}\n`);
  };

  const mount = async (alternateScreen = false): Promise<void> => {
    // Never overlap a new Sigil root with one that is still tearing down —
    // Sigil keys instances by stdout and two live roots corrupt the output.
    while (unmounting !== undefined) await unmounting;
    if (disposed || mounted !== undefined) return;
    const captureDirectStdio = options.captureConsole !== false;
    // Process output lives in the renderer's Static zone above every inline
    // view. Adding a static row commits it to scrollback and naturally moves
    // the live UI down, avoiding log-update's erase/restore path and its
    // render artifacts. `patchConsole: "stdio"` captures console, Node
    // warnings, and direct stream writes from tools such as Floci (the
    // renderer's own frames go through passthrough facades and bypass the
    // capture); `onCapturedOutput` takes ownership of each raw chunk so the
    // Static transcript renders it instead of the built-in splicing. The
    // renderer restores console and stream writes itself on unmount.
    const buffers = { stdout: "", stderr: "" };
    // A captured write that ends mid-line parks its tail here waiting for
    // the rest of the line. A real terminal would display the partial
    // immediately — so when no continuation arrives promptly, flush the
    // tail as its own row instead of holding it until unmount. Without the
    // deadline, a writer whose final chunk lacks a trailing newline (e.g.
    // a pretty-printed cause written raw to stderr) has its last line
    // appear only when the process exits. One timer PER STREAM: a chatty
    // stdout must not keep resetting the deadline of a parked stderr tail.
    const partialFlushTimers: {
      [Stream in keyof typeof buffers]?: ReturnType<typeof setTimeout>;
    } = {};
    const clearPartialFlush = (stream: keyof typeof buffers) => {
      const timer = partialFlushTimers[stream];
      if (timer !== undefined) {
        clearTimeout(timer);
        partialFlushTimers[stream] = undefined;
      }
    };
    const flushPartialLine = (stream: keyof typeof buffers) => {
      partialFlushTimers[stream] = undefined;
      if (buffers[stream] !== "") {
        store.appendStatic(<AnsiText wrap="none">{buffers[stream]}</AnsiText>);
        buffers[stream] = "";
      }
    };
    const appendLines = (stream: keyof typeof buffers, data: string) => {
      const parts = `${buffers[stream]}${data}`.split(/\r?\n/);
      buffers[stream] = parts.pop() ?? "";
      for (const line of parts) {
        store.appendStatic(<AnsiText wrap="none">{line || " "}</AnsiText>);
      }
      clearPartialFlush(stream);
      if (buffers[stream] !== "") {
        const timer = setTimeout(() => flushPartialLine(stream), 50);
        timer.unref?.();
        partialFlushTimers[stream] = timer;
      }
    };
    const sigil = render(
      <CliEnvironment capabilities={capabilities} observeWindow>
        <TerminalRoot store={store} />
      </CliEnvironment>,
      {
        stdin,
        stdout,
        stderr,
        exitOnCtrlC: false,
        interactive: capabilities.input,
        alternateScreen: alternateScreen,
        colorProfile: capabilities.colors ? "truecolor" : "none",
        ...(captureDirectStdio
          ? {
              patchConsole: "stdio" as const,
              onCapturedOutput: (stream: "stdout" | "stderr", data: string) => {
                appendLines(stream, data);
                return true;
              },
            }
          : { patchConsole: false as const }),
      },
    );
    const current: Mounted = {
      sigil,
      alternate: alternateScreen,
      exit: Promise.resolve(),
      flushDirectStdio: captureDirectStdio
        ? () => {
            // AnsiText, matching the line and deadline paths: a trailing
            // fragment must not render color-stripped just because teardown
            // won the race against the 50ms deadline.
            for (const stream of ["stdout", "stderr"] as const) {
              clearPartialFlush(stream);
              if (buffers[stream] !== "") {
                store.appendStatic(
                  <AnsiText wrap="none">{buffers[stream]}</AnsiText>,
                );
                buffers[stream] = "";
              }
            }
          }
        : undefined,
    };
    // Capture the exit promise at mount time: Sigil registers its process
    // `beforeExit` listener on the first `waitUntilExit()` call and `unmount`
    // only removes a listener that already exists, so waiting only after
    // unmount leaks one process listener per mount cycle. A rejection means a
    // component threw during render — Sigil has already unmounted itself, so
    // drop the dead instance and surface the error instead of hanging.
    current.exit = sigil.waitUntilExit().then(
      () => undefined,
      (error: unknown) => {
        // The crashed instance is dropped without the unmount path, so
        // disarm any pending partial-flush timer here too.
        current.flushDirectStdio?.();
        if (mounted === current) mounted = undefined;
        failRenderer(error);
      },
    );
    mounted = current;
  };

  const ensureMounted = () => Effect.promise(() => mount());

  const waitForRender = () =>
    mounted?.sigil.waitUntilRenderFlush().catch(() => undefined) ??
    Promise.resolve();

  /**
   * Tear down the renderer. Total (never rejects) and re-validated across its
   * awaits: output printed or live views opened while the final frame flushes
   * abort the teardown instead of being destroyed with it. `force` skips the
   * re-validation for dispose and presentation switches.
   */
  const unmount = (force = false): Promise<void> => {
    if (unmounting !== undefined) return unmounting;
    const current = mounted;
    if (current === undefined) return Promise.resolve();
    unmounting = (async () => {
      try {
        current.flushDirectStdio?.();
        // Drain: keep flushing until no new static output arrives between
        // flushes, so a `print` racing the teardown reaches the terminal.
        // Unbounded by design — the bound is the renderer's convergence: the
        // loop exits as soon as producers go quiet for one full flush.
        let staticCount;
        do {
          staticCount = store.snapshot().staticItems.length;
          await current.sigil.waitUntilRenderFlush();
        } while (store.snapshot().staticItems.length !== staticCount);
        // Re-validate: a prompt or live view may have re-armed the renderer
        // while the frame flushed. Their output would be destroyed by the
        // teardown, so leave the instance mounted for them instead.
        if (!force && (applicationMounted || !store.idle)) return;
        // A captured chunk that arrived DURING the drain may have parked a
        // partial line and armed a flush timer. Flush and disarm now —
        // otherwise the timer fires after `clearStatic()` below and the
        // stale fragment replays at the top of the next mount.
        current.flushDirectStdio?.();
        mounted = undefined;
        // unmount restores the patched console and stream writes.
        current.sigil.unmount();
        await current.exit;
        current.sigil.cleanup();
        // Static output has been handed off to the terminal. Do not replay
        // it when a later live session mounts a fresh Sigil root.
        store.clearStatic();
      } catch {
        // Teardown must be total: a crashed instance still ends up unmounted
        // with console/stream patches restored — and with no armed partial
        // flush timer left to poke the store after clearStatic.
        if (mounted === current) mounted = undefined;
        try {
          current.flushDirectStdio?.();
          current.sigil.unmount();
        } catch {
          // Already unmounted (or unmount itself is what threw above).
        }
      }
    })().finally(() => {
      unmounting = undefined;
    });
    return unmounting;
  };

  const releaseIfIdle = () =>
    Effect.suspend(() =>
      applicationMounted || !store.idle
        ? Effect.void
        : Effect.promise(() => unmount()),
    );

  const formatView = (view: View, renderOptions: RenderOptions = {}) =>
    formatStaticView(normalizeView(view), renderOptions, {
      ...capabilities,
      // Re-read the width at render time — the boot-time snapshot goes stale
      // the moment the user resizes the terminal.
      columns: stdout.columns ?? capabilities.columns,
    });

  const renderView = (view: View, renderOptions: RenderOptions = {}) =>
    Effect.sync(() => formatView(view, renderOptions));

  const print = (view: View, renderOptions: RenderOptions = {}) =>
    Effect.gen(function* () {
      const inApplication = yield* InApplication;
      view = normalizeView(view);
      if (inApplication) {
        yield* Effect.sync(() => store.append(view));
      } else if (mounted !== undefined) {
        yield* Effect.sync(() => store.appendStatic(view));
      } else {
        const output = yield* renderView(view, renderOptions);
        if (output !== "")
          yield* Effect.sync(() => stdout.write(`${output}\n`));
      }
    });

  const messageOptions = (
    message: string | { message: string; detail?: string },
  ) => (typeof message === "string" ? { message } : message);

  const log =
    (variant: "info" | "success" | "warning" | "error") =>
    (message: string | { message: string; detail?: string }) => {
      const options = messageOptions(message);
      return print(
        <Status variant={variant} detail={options.detail}>
          {options.message}
        </Status>,
      );
    };

  const run = <Value,>(screen: Screen<Value>) => {
    if (!capabilities.input) {
      return Effect.fail(
        new NonInteractiveTerminal({
          operation: screen.name,
          message: `Cannot run ${screen.name} without an interactive terminal. Provide the equivalent command flags instead.`,
        }),
      );
    }
    return Effect.gen(function* () {
      const inApplication = yield* InApplication;
      const interaction = promptGate.withPermits(1)(
        Effect.gen(function* () {
          let completedView: View | undefined;
          return yield* Effect.callback<Value, TerminalCancelled>((resume) => {
            let settled = false;
            const finish = (
              result: Effect.Effect<Value, TerminalCancelled>,
              resultView?: View,
            ) => {
              if (settled) return;
              settled = true;
              failActive = undefined;
              store.deactivate();
              if (resultView !== undefined) {
                if (inApplication) store.append(normalizeView(resultView));
                else completedView = resultView;
              }
              resume(result);
            };
            const cancel = () =>
              finish(
                Effect.fail(new TerminalCancelled()),
                <CancelledPrompt message={screen.name} />,
              );
            // A screen that throws during render unmounts Sigil with the error;
            // without this hook the callback would never resume and the CLI
            // would hang forever on a dead renderer.
            failActive = (error) => finish(Effect.die(error));
            store.activate(
              <ScreenCancelGuard onCancel={cancel}>
                {screen.render({
                  submit: (value, summary) =>
                    finish(Effect.succeed(value), summary),
                  cancel,
                })}
              </ScreenCancelGuard>,
            );
            // Not awaited (Effect.callback's register is synchronous), but
            // never fire-and-forget: a mount failure — e.g. a synchronous
            // throw from Sigil's render() — routes through `failRenderer`,
            // which fails this very interaction via the `failActive` hook
            // installed above instead of escaping as an unhandled rejection.
            mount().catch(failRenderer);
            // Interruption cleanup: deactivate the screen and let the caller's
            // finalizers release the renderer.
            return Effect.sync(() => {
              if (!settled) {
                settled = true;
                failActive = undefined;
                store.deactivate();
              }
            });
          }).pipe(
            Effect.ensuring(
              Effect.suspend(() =>
                inApplication
                  ? Effect.void
                  : releaseIfIdle().pipe(
                      Effect.andThen(
                        completedView === undefined
                          ? Effect.void
                          : print(completedView),
                      ),
                    ),
              ),
            ),
          );
        }),
      );
      return yield* inApplication
        ? interaction
        : rendererGate.withPermits(1)(interaction);
    });
  };

  const menu = <Value,>(
    options: MenuOptions<Value>,
  ): Effect.Effect<Value, InteractionError> =>
    Effect.gen(function* () {
      if (yield* InApplication) yield* Effect.sync(() => store.clear());
      return yield* run(menuScreen(options));
    });

  const app = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | NonInteractiveTerminal, R> =>
    !capabilities.input
      ? Effect.fail(
          new NonInteractiveTerminal({
            operation: "application",
            message:
              "Cannot run a CLI application without terminal input. Provide the equivalent command flags instead.",
          }),
        )
      : Effect.gen(function* () {
          if (yield* InApplication) return yield* effect;
          const presentation = yield* ApplicationPresentation;
          const alternate =
            presentation === "alternate" && capabilities.alternateScreen;
          return yield* rendererGate.withPermits(1)(
            Effect.acquireUseRelease(
              Effect.promise(async () => {
                applicationMounted = true;
                store.clear();
                // Sigil cannot change `alternateScreen` on a live instance: if
                // an inline renderer (say an earlier progress row) is still
                // mounted with the wrong presentation, remount with the
                // requested one instead of silently ignoring it.
                if (mounted !== undefined && mounted.alternate !== alternate) {
                  await unmount(true);
                }
                await mount(alternate);
              }),
              () => effect.pipe(Effect.provideService(InApplication, true)),
              () =>
                Effect.promise(async () => {
                  applicationMounted = false;
                  store.clear();
                  // Let the empty frame replace the application, then erase
                  // that frame explicitly. Unmount can now restore terminal
                  // modes without leaving the empty frame's newline behind.
                  const current = mounted;
                  if (current !== undefined) {
                    await current.sigil.waitUntilRenderFlush();
                    current.sigil.clear();
                  }
                  await unmount();
                }),
            ),
          );
        });

  // A wizard owns the renderer when invoked standalone and reuses the
  // current application renderer when nested. Prompt serialization remains
  // centralized in `run`, so nested profile/OAuth flows suspend cleanly.
  const wizard = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | NonInteractiveTerminal, R> =>
    Effect.gen(function* () {
      if (!(yield* InApplication)) return yield* app(effect);
      return yield* effect.pipe(
        Effect.ensuring(Effect.sync(() => store.clearTranscript())),
      );
    });

  const makeLive = (
    initial: View,
    options: LiveViewOptions = {},
  ): Effect.Effect<LiveViewHandle> =>
    Effect.gen(function* () {
      if (!capabilities.input) {
        yield* print(initial);
        return { close: Effect.void };
      }
      const inApplication = yield* InApplication;
      const key = store.alloc();
      let closed = false;
      yield* Effect.sync(() =>
        store.addLive(key, normalizeView(initial), options.placement),
      );
      yield* ensureMounted();
      return {
        close: Effect.suspend(() => {
          if (closed) return Effect.void;
          closed = true;
          // removeLive/completeLive no-op when the row was already cleared
          // by a menu loop or application boundary.
          if (options.persistOnClose)
            store.completeLive(
              key,
              inApplication ? "transcript" : "staticItems",
            );
          else store.removeLive(key);
          return Effect.promise(waitForRender).pipe(
            Effect.andThen(releaseIfIdle()),
          );
        }),
      };
    });

  /**
   * Scope-bound: the enclosing scope closes the view as a backstop, so an
   * interrupted caller can never leave an orphaned row keeping the renderer
   * mounted (and the process alive) forever.
   */
  const live = (
    initial: View,
    options: LiveViewOptions = {},
  ): Effect.Effect<LiveViewHandle, never, Scope.Scope> =>
    Effect.acquireRelease(makeLive(initial, options), (handle) => handle.close);

  /**
   * A progress row is just a live view over a runtime-owned store — the
   * handle mutates the store, React re-renders. Settling swaps the store to
   * its final state and commits the block to scrollback.
   */
  const makeProgress = (
    initial: ProgressOptions,
  ): Effect.Effect<ProgressHandle> =>
    Effect.gen(function* () {
      const dynamic =
        capabilities.input && ((yield* InApplication) || stdout.isTTY === true);
      if (!dynamic) {
        let current = initial;
        let closed = false;
        yield* print(
          <Status variant="info" detail={initial.detail}>
            {initial.label}
          </Status>,
        );
        const settle = (variant: "success" | "error", message?: string) =>
          Effect.suspend(() => {
            if (closed) return Effect.void;
            closed = true;
            return print(
              <Status variant={variant}>{message ?? current.label}</Status>,
            );
          });
        return {
          update: (next) =>
            Effect.sync(() => {
              if (!closed) current = next;
            }),
          succeed: (message) => settle("success", message),
          fail: (message) => settle("error", message),
          close: Effect.sync(() => {
            closed = true;
          }),
        } satisfies ProgressHandle;
      }
      const inApplication = yield* InApplication;
      const progressStore = new LiveStore<ProgressState>({ options: initial });
      const key = store.alloc();
      yield* Effect.sync(() =>
        store.addLive(key, <ProgressView store={progressStore} />),
      );
      yield* ensureMounted();
      let settled = false;
      const finishRow = (persist: boolean) =>
        Effect.suspend(() => {
          if (settled) return Effect.void;
          settled = true;
          // completeLive/removeLive no-op when the row was already cleared
          // by a menu loop or application boundary.
          if (persist)
            store.completeLive(
              key,
              inApplication ? "transcript" : "staticItems",
            );
          else store.removeLive(key);
          return Effect.promise(waitForRender).pipe(
            Effect.andThen(releaseIfIdle()),
          );
        });
      const settle = (variant: "success" | "error", message?: string) =>
        Effect.suspend(() => {
          if (settled) return Effect.void;
          progressStore.update((state) => ({
            ...state,
            final: { variant, message },
          }));
          return finishRow(true);
        });
      return {
        update: (next) =>
          Effect.sync(() => {
            if (!settled) progressStore.set({ options: next });
          }),
        succeed: (message) => settle("success", message),
        fail: (message) => settle("error", message),
        // An unsettled close abandons the row rather than committing it.
        close: finishRow(false),
      } satisfies ProgressHandle;
    });

  const progress = (
    initial: ProgressOptions,
  ): Effect.Effect<ProgressHandle, never, Scope.Scope> =>
    Effect.acquireRelease(makeProgress(initial), (handle) => handle.close);

  const service: CliKit["Service"] = {
    terminal: capabilities,
    nativeProgress: {
      set: (state, value) =>
        Effect.sync(() => {
          if (mounted !== undefined) mounted.sigil.setProgress(state, value);
          else setNativeProgress(state, value, stdout);
        }),
    },
    output: {
      print,
      format: formatView,
      render: renderView,
      info: log("info"),
      success: log("success"),
      warning: log("warning"),
      error: log("error"),
    },
    prompt: {
      text: (inputOptions) => run(textScreen(inputOptions)),
      password: (inputOptions) => run(passwordScreen(inputOptions)),
      confirm: (confirmOptions) => run(confirmScreen(confirmOptions)),
      select: (selectOptions) => run(selectScreen(selectOptions)),
      multiSelect: (selectOptions) => run(multiSelectScreen(selectOptions)),
      cycle: (selectOptions) => run(cycleSelectScreen(selectOptions)),
      awaitExternal: (externalOptions) =>
        run(awaitExternalScreen(externalOptions)),
      menu,
      custom: run,
    },
    wizard,
    application: app,
    live: { progress, open: live },
    task: (taskOptions, effect) =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* progress(taskOptions);
          return yield* effect.pipe(
            Effect.onExit((exit) =>
              Exit.isSuccess(exit)
                ? handle.succeed()
                : // Interruption (Ctrl+C) is not a failure — remove the row
                  // instead of painting a red error status.
                  Cause.hasInterruptsOnly(exit.cause)
                  ? handle.close
                  : handle.fail(),
            ),
          );
        }),
      ),
  };

  return {
    service,
    dispose: async () => {
      // After dispose the runtime must never mount again; force teardown even
      // if stray live rows were leaked.
      disposed = true;
      await unmount(true);
    },
  };
};
