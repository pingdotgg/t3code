// @effect-diagnostics globalDate:off globalJsonInEffect:off - probe windows are wall-clock; the probe types its own JSON.
/**
 * mobile:metrics' interactions. Each measured step opens a probe window, makes one real tap,
 * swipe or typed string through agent-device, waits until the app is quiet, and reads the window.
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { AxNode, Device, ProbeState } from "../../mobile-behavior/device.ts";
import type { Session } from "../../mobile-behavior/session.ts";
import { stepOf, type PerfWindow, type Step } from "./report.ts";

export class CaseFailure extends Schema.TaggedError<CaseFailure>()("CaseFailure", {
  message: Schema.String,
}) {}

/** Threads the seed creates, by the title their Home row shows. */
export interface Fixtures {
  readonly short: { readonly id: ThreadId; readonly title: string };
  readonly long: { readonly id: ThreadId; readonly title: string };
  /** A side chat of the short thread. */
  readonly sideChat: { readonly id: ThreadId; readonly title: string };
}

export interface CaseContext {
  readonly session: Session;
  readonly device: Device;
  readonly fixtures: Fixtures;
  readonly round: number;
  /** Threads opened so far in this app launch, for first visit versus revisit. */
  readonly visited: Set<string>;
}

/** How long the app must stay without input, commits or new content to end a step. */
const QUIET_MS = 1_000;
/** A working thread commits on every streamed chunk, so its steps end this long after content. */
const AFTER_CONTENT_MS = 1_200;
const STEP_TIMEOUT_MS = 15_000;

const Peek = Schema.fromJsonString(
  Schema.Struct({
    now: Schema.Number,
    last: Schema.Number,
    inputs: Schema.Number,
    content: Schema.Array(Schema.String),
  }),
);
const decodePeek = Schema.decodeUnknownEffect(Peek);

/** Runs `act` inside a probe window and returns what it measured. */
const measure = Effect.fn("metrics.measure")(function* (
  ctx: CaseContext,
  step: Pick<Step, "case" | "step" | "visit">,
  act: Effect.Effect<unknown, { readonly message: string }>,
  options: { readonly thread?: string } = {},
) {
  const { device } = ctx;
  yield* device.evaluate("__t3Behavior.perfStart()");
  const acted = yield* Effect.result(act);
  const deadline = (yield* Clock.currentTimeMillis) + STEP_TIMEOUT_MS;
  let contentSince: number | null = null;
  while (acted._tag === "Success" && (yield* Clock.currentTimeMillis) < deadline) {
    const peek = yield* device.evaluate("__t3Behavior.perfPeek()").pipe(
      Effect.flatMap((value) => decodePeek(value)),
      Effect.orElseSucceed(() => null),
    );
    if (peek) {
      const shown = options.thread
        ? peek.content.some((thread) => thread.endsWith(options.thread!))
        : true;
      if (shown && options.thread) contentSince ??= peek.now;
      const quiet = peek.inputs > 0 && peek.now - peek.last > QUIET_MS;
      if (shown && (quiet || (contentSince !== null && peek.now - contentSince > AFTER_CONTENT_MS)))
        break;
    }
    yield* Effect.sleep("250 millis");
  }
  const window = JSON.parse(
    String(yield* device.evaluate("__t3Behavior.perfStop()")),
  ) as PerfWindow;
  if (acted._tag === "Failure")
    return yield* new CaseFailure({
      message: `${step.case} ${step.step}: ${acted.failure.message}`,
    });
  return stepOf(window, { ...step, round: ctx.round }, options.thread ?? null);
});

const isThread = (state: ProbeState, threadId: string) =>
  state.route?.name === "Thread" && state.route.params.threadId === threadId;

/** Back to Home's chat list, unmeasured: phones stack threads over it, and tabs share its route. */
const toHome = Effect.fn("metrics.toHome")(function* (ctx: CaseContext) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const state = yield* ctx.device.state;
    if (state.route?.name === "Home") break;
    // UIKit can report an unknown outcome while the pop animates; the next state read decides.
    yield* ctx.device.back.pipe(Effect.ignore);
    yield* Effect.sleep("800 millis");
  }
  yield* ctx.device.waitFor("Home", (state) => state.route?.name === "Home", 5_000);
  yield* ctx.device.press('role=button label="Chats"').pipe(Effect.ignore);
});

/** Finds an on-screen node, skipping list containers that repeat a row's label. */
const findNode = Effect.fn("metrics.findNode")(function* (
  ctx: CaseContext,
  description: string,
  match: (label: string) => boolean,
) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const node = (yield* ctx.device.nodes).find(
      (entry) => entry.label !== undefined && entry.kind !== "scroll-area" && match(entry.label),
    ) as (AxNode & { readonly ref?: string }) | undefined;
    if (node?.ref) return `@${node.ref}`;
    if (node?.label) return `label="${node.label}"`;
    yield* Effect.sleep("500 millis");
  }
  return yield* new CaseFailure({ message: `No ${description} on screen.` });
});

/** Taps the shared PR/issues list switcher by the centre of its labelled view. */
const pressSwitcher = Effect.fn("metrics.pressSwitcher")(function* (
  ctx: CaseContext,
  label: string,
) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const node = (yield* ctx.device.nodes).find((entry) => entry.label === label && entry.rect);
    if (node) {
      const { x, y } = ctx.device.center(node);
      return yield* ctx.device.pressAt(x, y);
    }
    yield* Effect.sleep("500 millis");
  }
  return yield* new CaseFailure({ message: `No "${label}" on screen.` });
});

/** A Home row's label is its title and status, e.g. "Bench short, Done". */
const isRow = (label: string | undefined, title: string) =>
  label === title || label?.startsWith(`${title}, `) === true;

/** Waits for a Home row and returns its selector, opening the Working shelf if the row folded into it. */
const waitForRow = Effect.fn("metrics.waitForRow")(function* (ctx: CaseContext, title: string) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const nodes = yield* ctx.device.nodes;
    const row = nodes.find((node) => isRow(node.label, title)) as
      | (AxNode & { readonly ref?: string })
      | undefined;
    // The label ends in a relative time ("Bench short, 4m") that can tick before the press.
    if (row?.ref) return `@${row.ref}`;
    if (row?.label) return `label="${row.label}"`;
    const shelf = nodes.find((node) => /^\d+ working threads?$/.test(node.label ?? ""));
    if (shelf?.label && attempt % 4 === 1) yield* ctx.device.press(`label="${shelf.label}"`);
    yield* Effect.sleep("500 millis");
  }
  return yield* new CaseFailure({ message: `Row "${title}" never appeared on Home.` });
});

/** Opens a thread by tapping its Home row, measured from the tap to its rows on screen. */
const openFromHome = Effect.fn("metrics.openFromHome")(function* (
  ctx: CaseContext,
  name: string,
  thread: { readonly id: ThreadId; readonly title: string },
) {
  yield* toHome(ctx);
  const row = yield* waitForRow(ctx, thread.title);
  const visit = ctx.visited.has(thread.id) ? "revisit" : "first";
  ctx.visited.add(thread.id);
  const step = yield* measure(ctx, { case: name, step: "open", visit }, ctx.device.press(row), {
    thread: thread.id,
  });
  yield* ctx.device.waitFor("the tapped thread", (state) => isThread(state, thread.id), 10_000);
  return step;
});

const switchTo = (name: "short" | "long") =>
  Effect.fn(`metrics.switch.${name}`)(function* (ctx: CaseContext) {
    return [yield* openFromHome(ctx, `switch-${name}`, ctx.fixtures[name])];
  });

/** Opens a thread, unmeasured, and waits for its feed. */
const openThread = Effect.fn("metrics.openThread")(function* (
  ctx: CaseContext,
  thread: Fixtures[keyof Fixtures],
) {
  yield* toHome(ctx);
  yield* ctx.device.press(yield* waitForRow(ctx, thread.title));
  ctx.visited.add(thread.id);
  yield* ctx.device.waitFor(
    "the thread's feed",
    (state) => isThread(state, thread.id) && state.feed?.ready === true,
    20_000,
  );
  yield* Effect.sleep("1 second");
});

const TYPED = "check the helpers";

type CaseRun = (
  ctx: CaseContext,
) => Effect.Effect<ReadonlyArray<Step>, { readonly message: string }, SecureRandom.SecureRandom>;

export const CASES = {
  "switch-short": switchTo("short"),
  "switch-long": switchTo("long"),
  /**
   * A thread streaming a reply, opened twice. Each round starts its own and stops it after, since a
   * stream anywhere keeps Home committing and no other step would ever go quiet.
   */
  "switch-working": Effect.fn("metrics.switch.working")(function* (ctx: CaseContext) {
    const title = `Bench working ${ctx.round}`;
    const id = yield* ctx.session.env.launch(title, "Write the report. [[eval:stream:3000:120]]");
    const thread = { id, title };
    return yield* Effect.gen(function* () {
      yield* waitForRow(ctx, `${title}, Working`).pipe(Effect.ignore);
      return [
        yield* openFromHome(ctx, "switch-working", thread),
        yield* openFromHome(ctx, "switch-working", thread),
      ];
    }).pipe(Effect.ensuring(ctx.session.env.interruptAll().pipe(Effect.ignore)));
  }),

  /** The tab bar: pull requests, usage, then back to chats. */
  tabs: Effect.fn("metrics.tabs")(function* (ctx: CaseContext) {
    yield* toHome(ctx);
    const steps: Step[] = [];
    for (const [step, label] of [
      ["pulls", "PRs"],
      ["usage", "Usage"],
      ["chats", "Chats"],
    ] as const) {
      steps.push(
        yield* measure(
          ctx,
          { case: "tabs", step, visit: "step" },
          ctx.device.press(`role=button label="${label}"`),
        ),
      );
    }
    return steps;
  }),

  /** The pull request list, then the branch's pull request with its body, files and comments. */
  "pull-request": Effect.fn("metrics.pullRequest")(function* (ctx: CaseContext) {
    yield* toHome(ctx);
    const steps: Step[] = [];
    steps.push(
      yield* measure(
        ctx,
        { case: "pull-request", step: "list", visit: "step" },
        ctx.device.press('role=button label="PRs"'),
      ),
    );
    const row = yield* findNode(ctx, "pull request row", (label) =>
      label.includes("Bench change 1"),
    );
    steps.push(
      yield* measure(
        ctx,
        { case: "pull-request", step: "details", visit: "step" },
        ctx.device.press(row),
      ),
    );
    yield* ctx.device.back;
    yield* Effect.sleep("800 millis");
    yield* ctx.device.press('role=button label="Chats"');
    return steps;
  }),

  /** The issues list, which shares the pull requests' tab slot through the list switcher. */
  issues: Effect.fn("metrics.issues")(function* (ctx: CaseContext) {
    yield* toHome(ctx);
    yield* ctx.device.press('role=button label="PRs"');
    // The header title (SharedSlotTitle) is a menu trigger whose whole area belongs to its child
    // views, so agent-device will not tap it by ref; tap its centre instead.
    yield* pressSwitcher(ctx, "Pull requests, switch list");
    const target = yield* findNode(ctx, "Issues menu item", (label) => label === "Issues");
    const step = yield* measure(
      ctx,
      { case: "issues", step: "list", visit: "step" },
      ctx.device.press(target),
    );
    // Hand the slot back, so the pull request case finds its tab.
    yield* pressSwitcher(ctx, "Issues, switch list");
    yield* ctx.device.press(
      yield* findNode(ctx, "Pull requests menu item", (label) => label === "Pull requests"),
    );
    return [step];
  }),

  /** The thread on the 40-file branch: its git menu, then Review changes. */
  diff: Effect.fn("metrics.diff")(function* (ctx: CaseContext) {
    yield* openThread(ctx, ctx.fixtures.short);
    const git = yield* findNode(ctx, "Git controls menu", (label) => label === "Git controls");
    yield* ctx.device.press(git);
    const review = yield* findNode(ctx, "Review changes item", (label) =>
      label.startsWith("Review changes"),
    );
    const step = yield* measure(
      ctx,
      { case: "diff", step: "review", visit: "step" },
      ctx.device.press(review),
    );
    yield* ctx.device.back.pipe(Effect.ignore);
    return [step];
  }),

  /** From the short thread, its side chat's chip: tap to the side chat's rows. */
  "side-chat": Effect.fn("metrics.sideChat")(function* (ctx: CaseContext) {
    yield* openThread(ctx, ctx.fixtures.short);
    const chat = ctx.fixtures.sideChat;
    const visit = ctx.visited.has(chat.id) ? "revisit" : "first";
    ctx.visited.add(chat.id);
    const step = yield* measure(
      ctx,
      { case: "side-chat", step: "open", visit },
      ctx.device.press(
        yield* findNode(ctx, "side chat chip", (label) =>
          label.startsWith(`Open side chat ${chat.title}`),
        ),
      ),
      { thread: chat.id },
    );
    return [step];
  }),

  /** Keys typed into a short thread's composer, each to its next JS frame. */
  type: Effect.fn("metrics.type")(function* (ctx: CaseContext) {
    yield* openThread(ctx, ctx.fixtures.short);
    const editor = (yield* ctx.device.nodes).find(
      (node) => node.kind === "text-view" && node.editable === true,
    );
    if (!editor?.rect) return yield* new CaseFailure({ message: "No composer on screen." });
    const { x, y } = ctx.device.center(editor);
    yield* ctx.device.pressAt(x, y);
    yield* ctx.device.waitFor("the keyboard", (state) => state.composer.keyboard, 10_000);
    yield* Effect.sleep("1 second");
    const step = yield* measure(
      ctx,
      { case: "type", step: "keys", visit: "step" },
      ctx.device.type(TYPED),
    );
    // Clear the draft so the next round types into the same empty composer.
    yield* ctx.device.run(["fill", String(x), String(y), ""]).pipe(Effect.ignore);
    yield* ctx.device.run(["keyboard", "dismiss"]).pipe(Effect.ignore);
    return [step];
  }),

  /** Drags the long timeline up through history: frames while the list lays out older rows. */
  "scroll-long": Effect.fn("metrics.scrollLong")(function* (ctx: CaseContext) {
    yield* openThread(ctx, ctx.fixtures.long);
    const root = (yield* ctx.device.nodes)[0]?.rect ?? { x: 0, y: 0, width: 400, height: 870 };
    const x = Math.round(root.width / 2);
    const drag = Effect.gen(function* () {
      for (let swipe = 0; swipe < 4; swipe++)
        yield* ctx.device.swipe(x, Math.round(root.height * 0.3), Math.round(root.height * 0.8));
    });
    return [yield* measure(ctx, { case: "scroll-long", step: "drag-up", visit: "step" }, drag)];
  }),
} satisfies Record<string, CaseRun>;

export type CaseName = keyof typeof CASES;
export const CASE_NAMES = Object.keys(CASES) as ReadonlyArray<CaseName>;
