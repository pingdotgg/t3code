// Ported from LocalRouter (github.com/jayleaton/localrouter @fe24726, apps/desktop-helper/src/computer/controller.ts), modified for Ada.
import type { Logger } from "./log.ts";
import { choiceProbability } from "./decisions.ts";
import type { Answers, Decider, Question } from "./decisions.ts";
import { needsPointer } from "./types.ts";
import type {
  ActResult,
  BrowserTab,
  BrowserTabs,
  Observation,
  PointerWatch,
  ScreenAction,
  ScreenBackend,
  ScreenControl,
  TabGroup,
} from "./types.ts";

/**
 * Computer use: the helper moves the real cursor, clicks, scrolls, and types on this computer toward a goal.
 * It picks the surface (an open browser tab or an app window), then repeats one small decision per
 * step, choosing among the controls the screen actually has, until the goal is reached or no step is
 * clearly right. Time spent waiting for the server is not working time.
 */
export type ComputerTask = {
  goal: string;
  /** Exact text to type (a message, a search), if the task types anything. */
  text: string | null;
};

export type ComputerOutcome = {
  status: "done" | "stuck" | "blocked" | "unavailable" | "stopped" | "failed";
  /** Why it stopped, in words for the user (empty when done). */
  reason: string;
  /** What it did, step by step. */
  steps: string[];
  /** Where it worked: "Google Chrome: Early AI-dopters". */
  surface: string | null;
};

/** The screen an action is asked about, as the server binds an approval to it. */
export type ObservationSummary = { app: string; title: string; url?: string };

/** One action exactly as the server is asked to grant it (the protocol's `authorize.action`). */
export type AuthorizeAction =
  | { kind: "click"; ref: string; role: ScreenControl["role"]; label: string }
  | { kind: "type"; ref: string; role: ScreenControl["role"]; label: string; text: string }
  /** `field`: the text box typed into before this Enter. */
  | {
      kind: "press";
      key: "enter" | "escape" | "tab" | "space";
      field?: { role: ScreenControl["role"]; label: string };
    }
  | { kind: "scroll"; direction: "up" | "down" | "top" | "bottom" }
  | { kind: "surface"; what: "tab" | "app"; name: string }
  /** The real pointer and keyboard for one step that cannot be done in the background (`step`: the action, `why`: the backend's reason). */
  | {
      kind: "pointer";
      step: string;
      why: string;
      target: { role: ScreenControl["role"]; label: string } | null;
    };

export type AuthorizeRequest = {
  step: number;
  observation: ObservationSummary;
  action: AuthorizeAction;
};

/** The server's answer: a grant (at once, or after the user's tap), or a refusal with a reason for the user. */
export type Grant = { ok: true; grant: "allow" | "approved" } | { ok: false; denied: string };

/** Asks the server for one action. Rejects when the server refuses the request itself (past a limit, not this task). */
export type Authorize = (request: AuthorizeRequest) => Promise<Grant>;

/** The server's limits for one task (from `use.start`), clamped to the helper's own. */
export type Limits = { maxSteps?: number; timeoutMs?: number };

export const MAX_STEPS = 15;
export const TIMEOUT_MS = 90_000;

/** What one task talks to: the server's decisions and grants, and where its progress goes. */
export type Session = {
  decider: Decider;
  authorize: Authorize;
  /** Each thing it did, in words ("clicked the button “Search”"), as it happens. */
  onStep?: (text: string) => void;
};

export type Deps = Session & {
  /** The browser's open tabs, and switching to one by clicking it in the tab strip. */
  tabs: BrowserTabs | null;
  /** Reads the frontmost window through accessibility and acts with the real cursor and keyboard. */
  desktop: ScreenBackend | null;
  /** The Dock's apps: the user's own list of the apps they work in, and bringing one forward by clicking its icon. */
  dock: { list(): Promise<string[]>; activate(name: string): Promise<unknown> } | null;
  /** Running app names, for apps that are not in the Dock, and bringing one to the front. */
  apps: { running(): Promise<string[]>; activate(name: string): Promise<void> } | null;
  log: Logger;
  minConfidence?: number;
  /** Time for the screen to settle after an action. */
  settleMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type RunOptions = {
  signal?: AbortSignal;
  limits?: Limits;
  /** The local stop for this task: checked before each action, told when the helper moves the pointer. */
  watch?: PointerWatch;
};

const STATE_NOTE = "`goal` is what the user wants done on screen.";
const VISUAL_NOTE =
  "A screenshot, because the app would not show its window through accessibility: only its text is listed (clicking a text clicks where it is), not icons such as a play button.";
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 60);
  }
};
const describeControl = (control: ScreenControl) =>
  `${control.role} “${clip(control.label || "(no label)", 90)}”${control.value ? ` containing “${clip(control.value, 60)}”` : ""}${control.focused ? " (focused)" : ""}`;
const summary = (screen: Observation): ObservationSummary => ({
  app: screen.app,
  title: screen.title,
  ...(screen.url ? { url: screen.url } : {}),
});
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Why the task was aborted: the reason given to abort(), when it is words. */
export function stopReason(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  return typeof reason === "string" && reason ? reason : "You stopped it.";
}

/** A limit from the server, clamped to the helper's own: never more, and the helper's when missing. */
export function clampLimit(value: number | undefined, max: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.min(max, Math.floor(value))
    : max;
}

/** Ends the run from anywhere inside it with an outcome. */
class Halt extends Error {
  readonly status: ComputerOutcome["status"];

  constructor(status: ComputerOutcome["status"], reason: string) {
    super(reason);
    this.status = status;
  }
}

/** One task's running state. Working time is wall time minus the time spent waiting for the server. */
type Run = {
  task: ComputerTask;
  signal: AbortSignal;
  watch: PointerWatch | null;
  steps: string[];
  maxSteps: number;
  timeoutMs: number;
  started: number;
  waited: number;
  authorized: number;
  /** The text box the task typed into, for the Enter that follows. */
  typedInto: ScreenControl | null;
};

type Decision =
  | { action: ScreenAction; step: string }
  | { stop: ComputerOutcome["status"]; reason: string };

export class ComputerUse {
  private readonly deps: Deps;
  private readonly min: number;
  private readonly settleMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: Deps) {
    this.deps = deps;
    this.min = deps.minConfidence ?? 0.55;
    this.settleMs = deps.settleMs ?? 600;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get available() {
    return Boolean(this.deps.desktop);
  }

  async run(given: ComputerTask, options: RunOptions = {}): Promise<ComputerOutcome> {
    // "Go to example.com" carries the text to type in the goal itself: the address, taken literally.
    const task: ComputerTask =
      given.text === null ? { ...given, text: navigationText(given.goal) } : given;
    const run: Run = {
      task,
      signal: options.signal ?? new AbortController().signal,
      watch: options.watch ?? null,
      steps: [],
      maxSteps: clampLimit(options.limits?.maxSteps, MAX_STEPS),
      timeoutMs: clampLimit(options.limits?.timeoutMs, TIMEOUT_MS),
      started: this.now(),
      waited: 0,
      authorized: 0,
      typedInto: null,
    };
    let surface: string | null = null;
    const end = (
      status: ComputerOutcome["status"],
      reason: string,
      where: string | null = surface,
    ): ComputerOutcome => {
      this.deps.log.info("computer_use.finished", {
        status,
        steps: run.steps.length,
        authorized: run.authorized,
        ms: this.now() - run.started,
        waited_ms: run.waited,
      });
      return { status, reason, steps: run.steps, surface: where };
    };
    try {
      this.checkpoint(run);
      const target = await this.chooseSurface(run);
      if ("unavailable" in target) return end("unavailable", target.unavailable, null);
      const backend = target.backend;
      this.record(run, target.step);
      // Names the goal quotes ("click the tab 'Widget library review'") are clicked by matching, not guessed.
      const quoted = quotedTargets(task.goal);
      const clicked = new Set<string>(target.clicked ?? []);
      // Going to a tab is done once the tab is clicked: the name it was asked by need not be written on the page.
      if (target.switchedTab && plainClickGoal(task)) return end("done", "", target.switchedTab);
      if (quoted.length && quoted.every((name) => clicked.has(name)) && plainClickGoal(task))
        return end("done", "");
      // The same action on a screen it was already done on is not done again, but left out of that screen's next
      // question, with the decider told so: steering instead of retrying.
      const acted = new Set<string>();
      const avoidBy = new Map<string, Map<string, string>>();
      for (let step = 0; step < run.maxSteps; step += 1) {
        this.checkpoint(run);
        const screen = await backend.observe({ signal: run.signal });
        const key = screenKey(screen);
        const avoid = avoidBy.get(key) ?? new Map<string, string>();
        avoidBy.set(key, avoid);
        surface = `${screen.app}: ${clip(screen.title, 60)}`;
        // Only going to an address: done once the page on screen is on that host, rather than leaving it to the decider.
        if (pureNavigation(task.goal) && navigationReached(task.goal, screen))
          return end("done", "");
        const match = quoted.find((name) => !clicked.has(name));
        const direct = match ? matchControl(screen.controls, match) : null;
        if (match && direct) {
          await this.act(
            run,
            backend,
            screen,
            { kind: "click", ref: direct.ref },
            `clicked the ${describeControl(direct)}`,
          );
          clicked.add(match);
          if (quoted.every((name) => clicked.has(name)) && plainClickGoal(task))
            return end("done", "");
          await this.sleep(this.settleMs);
          continue;
        }
        const decision = await this.decide(run, screen, avoid);
        const tried = [...avoid.values()].at(-1);
        // A quoted name that is not on screen is the honest reason to give, not "could not tell what to do".
        if ("stop" in decision && decision.stop === "stuck" && match)
          return end("stuck", `It could not find “${match}” in ${screen.app}.`);
        if ("stop" in decision && decision.stop === "stuck" && tried)
          return end(
            "stuck",
            `It kept doing the same thing (${tried}) without the screen changing, and nothing else on screen looked right.`,
          );
        if ("stop" in decision) return end(decision.stop, decision.reason);
        this.checkpoint(run);
        const { action, step: said } = decision;
        const signature = `${JSON.stringify(action)}|${key}`;
        // Typing is offered again only when the field lost the text (the app put its own back), and its read-back fails a step
        // that did not land. A background action that left the screen as it was is steered away from, never retried behind the person.
        const same = acted.has(signature) && action.kind !== "type";
        if (same) {
          avoid.set(actionKey(action), said);
          continue;
        }
        acted.add(signature);
        await this.act(run, backend, screen, action, said);
        // Typing starts a new attempt: what was tried before it (an Enter the app lost) may be right again after it.
        if (action.kind === "type") {
          acted.clear();
          avoidBy.clear();
        }
        await this.sleep(this.settleMs);
      }
      return end("stuck", `It did not finish within ${run.maxSteps} steps.`);
    } catch (error) {
      if (run.signal.aborted) return end("stopped", stopReason(run.signal));
      if (error instanceof Halt) return end(error.status, error.message);
      return end("failed", messageOf(error));
    }
  }

  /** Stops the run when it was aborted, or when its working time (waits for the server excluded) is up. */
  private checkpoint(run: Run) {
    if (run.signal.aborted) throw new Halt("stopped", stopReason(run.signal));
    if (this.now() - run.started - run.waited > run.timeoutMs)
      throw new Halt("stuck", "It was taking too long.");
  }

  private record(run: Run, text: string) {
    run.steps.push(text);
    try {
      this.deps.onStep?.(text);
    } catch (error) {
      this.deps.log.warn("computer_use.progress_failed", { error: messageOf(error) });
    }
  }

  /** Asks the server, and refuses any answer outside the questions and candidates it was offered. */
  private async ask(
    run: Run,
    state: unknown,
    questions: Record<string, Question>,
  ): Promise<Answers> {
    const asked = this.now();
    let answers: Answers;
    try {
      answers = await this.deps.decider.ask(state, questions);
    } catch (error) {
      throw new Halt("stuck", `The server could not decide the next step: ${messageOf(error)}`);
    } finally {
      run.waited += this.now() - asked;
    }
    for (const [id, answer] of Object.entries(answers)) {
      const question = questions[id];
      const offered =
        question !== undefined &&
        question.type === answer.type &&
        (answer.type !== "choice" ||
          (question.type === "choice" && Object.hasOwn(question.criteria, answer.choice)));
      if (!offered)
        throw new Halt("stuck", "The decision named something it was not offered, so it stopped.");
    }
    return answers;
  }

  /** The chosen key of a Choice when it is confident enough; null when absent or unsure. */
  private confident(answers: Answers, id: string): string | null {
    const answer = answers[id];
    if (answer?.type !== "choice") return null;
    return choiceProbability(answers, id, answer.choice) >= this.min ? answer.choice : null;
  }

  /**
   * Asks the server to grant one action. The time spent waiting (a tap can take up to the approval
   * timeout) is not working time, and pointer movement meanwhile is not a takeover.
   */
  private async authorize(
    run: Run,
    observation: ObservationSummary,
    action: AuthorizeAction,
  ): Promise<"allow" | "approved"> {
    this.checkpoint(run);
    if (run.authorized >= run.maxSteps)
      throw new Halt("stuck", `It did not finish within ${run.maxSteps} steps.`);
    run.authorized += 1;
    const asked = this.now();
    run.watch?.moving();
    let grant: Grant;
    try {
      grant = await this.deps.authorize({ step: run.authorized, observation, action });
    } catch (error) {
      if (run.signal.aborted) throw new Halt("stopped", stopReason(run.signal));
      throw new Halt("stuck", `The server did not allow the next step: ${messageOf(error)}`);
    } finally {
      run.waited += this.now() - asked;
      // Waiting for the server used no pointer: the person's moves meanwhile and after are their own.
      if (run.watch?.released) run.watch.released();
      else run.watch?.left(null);
    }
    if (run.signal.aborted) throw new Halt("stopped", stopReason(run.signal));
    if (!grant.ok) throw new Halt("blocked", grant.denied || "The server did not allow that.");
    return grant.grant;
  }

  /** The local stop's last word before the helper touches anything. */
  private async beforeTouching(run: Run) {
    if (run.watch) await run.watch.check();
    this.checkpoint(run);
  }

  /**
   * One action on screen: the control it names must be on the screen it was chosen from, the server must grant it, and
   * after a tap the same control must still be there, or nothing happens. It is done in the background; when the
   * backend says it cannot be, the person is asked for their mouse, and only then is it done with the real pointer.
   */
  private async act(
    run: Run,
    backend: ScreenBackend,
    screen: Observation,
    action: ScreenAction,
    said: string,
  ): Promise<ActResult> {
    const request = this.request(run, screen, action);
    const grant = await this.authorize(run, summary(screen), request);
    if (grant === "approved") await this.sameControl(run, backend, screen, action);
    await this.beforeTouching(run);
    let result: ActResult;
    try {
      result = await this.perform(run, backend, action, false);
    } catch (error) {
      if (!needsPointer(error)) throw error;
      const target =
        action.kind === "click" || action.kind === "type" ? this.control(screen, action.ref) : null;
      await this.authorize(run, summary(screen), {
        kind: "pointer",
        step: said,
        why: error.why,
        target: target ? { role: target.role, label: target.label } : null,
      });
      await this.sameControl(run, backend, screen, action);
      await this.beforeTouching(run);
      result = await this.perform(run, backend, action, true);
    }
    if (action.kind === "type") run.typedInto = this.control(screen, action.ref);
    this.record(
      run,
      result.mode === "pointer" ? `${said} (with your mouse, as you allowed)` : said,
    );
    return result;
  }

  /** After a wait for the person: the control it chose is still there, on the same app, or nothing happens. */
  private async sameControl(
    run: Run,
    backend: ScreenBackend,
    screen: Observation,
    action: ScreenAction,
  ) {
    if (action.kind !== "click" && action.kind !== "type") return;
    const chosen = this.control(screen, action.ref);
    const now = await backend.observe({ signal: run.signal });
    const same = now.controls.find((control) => control.ref === action.ref);
    if (
      now.app !== screen.app ||
      !same ||
      same.role !== chosen.role ||
      same.label !== chosen.label
    ) {
      throw new Halt("stuck", "The screen changed while it waited for your OK, so it did not act.");
    }
  }

  /** Hands the action to the backend, telling the local stop when it uses the real pointer, so its own movement is not the person's. */
  private async perform(
    run: Run,
    backend: ScreenBackend,
    action: ScreenAction,
    allowPointer: boolean,
  ): Promise<ActResult> {
    if (allowPointer) run.watch?.moving();
    let result: ActResult;
    try {
      result = (await backend.act(action, {
        signal: run.signal,
        ...(allowPointer ? { allowPointer: true } : {}),
      })) ?? { mode: "background" };
    } catch (error) {
      if (allowPointer) run.watch?.left(null);
      throw error;
    }
    // Only a step done with the real pointer makes the person's moves just after it a takeover.
    if (allowPointer && result.mode !== "pointer" && run.watch?.released) run.watch.released();
    else if (allowPointer) run.watch?.left(result.pointer);
    return result;
  }

  /** The control a ref names on this screen; a ref that is not on it is never acted on. */
  private control(screen: Observation, ref: string): ScreenControl {
    const control = screen.controls.find((entry) => entry.ref === ref);
    if (!control) throw new Halt("stuck", "The control it chose is not on the screen.");
    return control;
  }

  /** The action as the server is asked to grant it: what is clicked or typed into, by role and label. */
  private request(run: Run, screen: Observation, action: ScreenAction): AuthorizeAction {
    switch (action.kind) {
      case "click": {
        const control = this.control(screen, action.ref);
        return { kind: "click", ref: action.ref, role: control.role, label: control.label };
      }
      case "type": {
        const control = this.control(screen, action.ref);
        return {
          kind: "type",
          ref: action.ref,
          role: control.role,
          label: control.label,
          text: action.text,
        };
      }
      case "press":
        return action.key === "enter" && run.typedInto
          ? {
              kind: "press",
              key: action.key,
              field: { role: run.typedInto.role, label: run.typedInto.label },
            }
          : { kind: "press", key: action.key };
      case "scroll":
        return { kind: "scroll", direction: action.direction };
    }
  }

  /** Brings a tab or an app forward, granted by the server first like any action. */
  private async surfaceChange<T>(
    run: Run,
    desktop: ScreenBackend,
    what: "tab" | "app",
    name: string,
    perform: () => Promise<T>,
  ): Promise<T> {
    const here = await desktop
      .observe()
      .then(summary, (): ObservationSummary => ({ app: "", title: "" }));
    await this.authorize(run, here, { kind: "surface", what, name });
    await this.beforeTouching(run);
    run.watch?.moving();
    try {
      return await perform();
    } finally {
      run.watch?.left(null);
    }
  }

  /**
   * Where to work: an open browser tab, an app from the Dock (the user's own list of their apps, with
   * running apps as backup), or whatever is in front. A tab named exactly in the goal is matched, not
   * guessed. When no single tab is clearly meant, the browser is brought forward and the steps work
   * from what is actually on screen: this never gives up before looking.
   */
  private async chooseSurface(
    run: Run,
  ): Promise<
    | { backend: ScreenBackend; step: string; clicked?: string[]; switchedTab?: string }
    | { unavailable: string }
  > {
    const { task } = run;
    const { tabs: browser, desktop, apps, dock } = this.deps;
    if (!desktop)
      return { unavailable: "Computer use needs accessibility access on this computer." };
    let unreadable: Error | null = null;
    const [tabs, docked, running] = await Promise.all([
      browser
        ? browser.list().catch((error: unknown) => {
            unreadable = error instanceof Error ? error : new Error(String(error));
            return [] as BrowserTab[];
          })
        : Promise.resolve([] as BrowserTab[]),
      dock ? dock.list().catch((): string[] => []) : Promise.resolve([] as string[]),
      apps ? apps.running().catch((): string[] => []) : Promise.resolve([] as string[]),
    ]);
    const candidates = [...new Set([...docked, ...running])].slice(0, 60);
    const quoted = quotedTargets(task.goal);
    const groups = browser?.groups ? await browser.groups().catch((): TabGroup[] => []) : [];
    const named = resolveTab(quoted, tabs, groups);
    const questions: Record<string, Question> = {
      surface: {
        type: "choice",
        instructions: `Where does this happen? ${STATE_NOTE}`,
        criteria: {
          browser: "In a website or web app, or a browser tab (including clicking a browser tab).",
          app: "In a native app window on this computer (not a website).",
          current: "In whatever is on screen right now; no app or site is named.",
        },
      },
      ...(tabs.length && !named
        ? {
            tab: {
              type: "choice",
              instructions: `Which open browser tab is it about? ${STATE_NOTE}`,
              criteria: {
                ...Object.fromEntries(
                  tabs.map((tab, index) => [
                    `t${index}`,
                    `${clip(tab.title || "(untitled)", 80)} (${host(tab.url)})`,
                  ]),
                ),
                none: "None of these tabs, or it is not clear which.",
              },
            },
          }
        : {}),
      ...(candidates.length
        ? {
            app: {
              type: "choice",
              instructions: `Which of the user's apps is it in? ${STATE_NOTE}`,
              criteria: {
                ...Object.fromEntries(candidates.map((name, index) => [`a${index}`, name])),
                none: "None of these apps.",
              },
            },
          }
        : {}),
    };
    const answers = await this.ask(run, { goal: task.goal }, questions);
    const where = named ? "browser" : (this.confident(answers, "surface") ?? "current");
    const chosenApp = this.confident(answers, "app");
    const app =
      chosenApp && chosenApp !== "none" ? candidates[Number(chosenApp.slice(1))] : undefined;
    const bringForward = (name: string) =>
      this.surfaceChange(run, desktop, "app", name, async () => {
        if (dock) await dock.activate(name);
        else if (apps) await apps.activate(name);
      });
    if (where === "browser" && browser) {
      const chosen = this.confident(answers, "tab");
      const tab =
        named?.tab ?? (chosen && chosen !== "none" ? tabs[Number(chosen.slice(1))] : undefined);
      if (tab) {
        // Clicks the tab in the browser's tab strip with the cursor, like a person would.
        await this.surfaceChange(run, desktop, "tab", tab.title, () => browser.activate(tab));
        const switched = `${browser.browser}: ${clip(tab.title, 60)}`;
        // Names that refer to the tab were what the tab was chosen by, so they are not looked for on screen afterwards.
        return {
          backend: desktop,
          step: `clicked the “${clip(tab.title, 60)}” tab (${host(tab.url)}) in ${browser.browser}${named ? ` (it matched “${named.name}” by ${named.via})` : ""}`,
          clicked: [...(named ? [named.name] : []), ...tabNames(task.goal)],
          switchedTab: switched,
        };
      }
      // Tabs that cannot be read cannot be clicked in the strip either: a tab the goal names is found
      // with the browser's own tab search, and the page is then worked from what is on screen.
      const failure = unreadable as Error | null;
      const tabName =
        tabNames(task.goal)[0] ??
        (/\btabs?\b/i.test(task.goal) ? quoted[0] : undefined) ??
        unquotedTabName(task.goal);
      const wanted = tabName ?? siteNamed(task.goal);
      const search = browser.search?.bind(browser);
      if (failure && wanted && search && (!app || app === browser.browser)) {
        const found = await this.surfaceChange(run, desktop, "tab", wanted, () => search(wanted));
        if (found)
          return {
            backend: desktop,
            step: `switched to the “${clip(found, 60)}” tab with ${browser.browser}’s tab search`,
            clicked: [wanted, ...tabNames(task.goal)],
            switchedTab: `${browser.browser}: ${clip(found, 60)}`,
          };
        if (tabName)
          return {
            unavailable: `It could not find a “${wanted}” tab with ${browser.browser}’s tab search.`,
          };
      }
      const name = app ?? browser.browser;
      await bringForward(name);
      return { backend: desktop, step: `brought ${name} to the front` };
    }
    if (where === "app" && app) {
      await bringForward(app);
      return { backend: desktop, step: `brought ${app} to the front` };
    }
    return { backend: desktop, step: "worked in the app in front" };
  }

  /** One step: which action next, chosen among the controls on screen (and where to type, when there is text). */
  private async decide(
    run: Run,
    screen: Observation,
    avoid: Map<string, string> = new Map(),
  ): Promise<Decision> {
    const { task } = run;
    const controls = screen.controls;
    // Going to an address whose page is not known to be there, and the field typed into no longer holds the address
    // (an app put its own text back after an Enter that went elsewhere): it may be typed again, as that is harmless.
    if (
      run.typedInto &&
      task.text &&
      navigationText(task.goal) &&
      !navigationReached(task.goal, screen)
    ) {
      const field = run.typedInto;
      const now = controls.find((c) => c.role === field.role && c.label === field.label);
      if (
        now?.value !== undefined &&
        !now.value.replace(/\s+/g, "").includes(task.text.replace(/\s+/g, ""))
      )
        run.typedInto = null;
    }
    const typed = run.typedInto !== null;
    const textboxes = controls
      .map((control, index) => ({ control, index }))
      .filter(({ control }) => control.role === "textbox");
    const canType = Boolean(task.text) && !typed && textboxes.length > 0;
    const state = {
      goal: task.goal,
      ...(task.text ? { textToType: clip(task.text, 400), alreadyTyped: typed } : {}),
      screen: {
        app: screen.app,
        title: screen.title,
        ...(screen.url ? { url: screen.url } : {}),
        visibleText: clip(screen.text ?? "", 1_500),
        ...(screen.visual ? { readFrom: VISUAL_NOTE } : {}),
      },
      stepsSoFar: run.steps.slice(-8),
      ...(avoid.size
        ? {
            triedWithoutEffect: [...avoid.values()],
            note: "Those moves did not change this screen, so they are not offered again; choose another.",
          }
        : {}),
    };
    const questions: Record<string, Question> = {
      next: {
        type: "choice",
        instructions: `What is the one next step toward the goal on this screen? Choose a control to click, or one of the other moves. ${STATE_NOTE}`,
        criteria: {
          // A text box that already has the focus is never a click to make: it changes nothing. With text still to type,
          // choosing it types instead (below).
          ...Object.fromEntries(
            controls
              .map(
                (control, index) => [`c${index}`, `Click the ${describeControl(control)}`] as const,
              )
              .filter(([key]) => {
                const control = controls[Number(key.slice(1))];
                return (
                  control !== undefined &&
                  !avoid.has(`click:${control.ref}`) &&
                  !(control.role === "textbox" && control.focused && !canType)
                );
              }),
          ),
          ...(avoid.has("scroll:down")
            ? {}
            : { scroll_down: "Scroll down to see more of this page or list." }),
          ...(avoid.has("scroll:up") ? {} : { scroll_up: "Scroll up to see earlier content." }),
          ...(canType
            ? { type_text: "Type the prepared text (`textToType`) into a text box." }
            : {}),
          ...(typed && !avoid.has("press:enter")
            ? {
                press_enter:
                  "Press Enter, for example to send what was just typed or to run a search.",
              }
            : {}),
          ...(avoid.has("press:space")
            ? {}
            : {
                press_space: "Press Space, which plays or pauses the video or audio on this page.",
              }),
          ...(navigationUnmet(task.goal, screen)
            ? {}
            : { done: "The goal is already done on this screen." }),
          stuck: "None of these moves toward the goal.",
        },
      },
      ...(canType
        ? {
            type_into: {
              type: "choice",
              instructions: `If typing now, which text box should the prepared text go into? ${STATE_NOTE}`,
              criteria: {
                ...Object.fromEntries(
                  textboxes.map(({ control, index }) => [`c${index}`, describeControl(control)]),
                ),
                none: "None of these.",
              },
            },
          }
        : {}),
    };
    const answers = await this.ask(run, state, questions);
    const next = this.confident(answers, "next");
    if (!next || next === "stuck")
      return { stop: "stuck", reason: `It could not tell what to do next on ${screen.app}.` };
    if (next === "done" && !navigationUnmet(task.goal, screen)) return { stop: "done", reason: "" };
    if (next === "scroll_down" || next === "scroll_up")
      return {
        action: { kind: "scroll", direction: next === "scroll_down" ? "down" : "up" },
        step: `scrolled ${next === "scroll_down" ? "down" : "up"}`,
      };
    if (next === "press_space")
      return { action: { kind: "press", key: "space" }, step: "pressed Space" };
    if (next === "press_enter")
      return { action: { kind: "press", key: "enter" }, step: "pressed Enter" };
    if (next === "type_text" && task.text) {
      const target = this.confident(answers, "type_into");
      const box =
        target && target !== "none"
          ? controls[Number(target.slice(1))]
          : controls.find((control) => control.role === "textbox" && control.focused);
      if (!box) return { stop: "stuck", reason: "It could not tell which box to type into." };
      return {
        action: { kind: "type", ref: box.ref, text: task.text },
        step: `typed the text into the ${describeControl(box)}`,
      };
    }
    const control = /^c\d+$/.test(next) ? controls[Number(next.slice(1))] : undefined;
    if (!control) return { stop: "stuck", reason: "The control it chose is not on the screen." };
    // Clicking a text box that already has the focus changes nothing: with text to type, that is where it goes.
    if (control.role === "textbox" && control.focused && canType && task.text) {
      return {
        action: { kind: "type", ref: control.ref, text: task.text },
        step: `typed the text into the ${describeControl(control)}`,
      };
    }
    return {
      action: { kind: "click", ref: control.ref },
      step: `clicked the ${describeControl(control)}`,
    };
  }
}

/** A task's own local stop: a PointerWatch that stops polling when the task ends. */
export type TaskWatch = PointerWatch & { end(): void };

export type RunsOptions = {
  /** A controller for one task, talking to that task's session with the server. */
  create: (session: Session) => ComputerUse;
  /** Starts the local stop for one task; `abort` ends the task with the reason given. */
  watch?: (abort: (reason: string) => void) => TaskWatch | null;
  /** Called as a task starts (the "Ada is using your Mac" notice). */
  onStart?: (task: ComputerTask) => void;
  log: Logger;
};

export type StartResult =
  | { ok: true; finished: Promise<ComputerOutcome> }
  | { ok: false; error: "busy" };

/** One computer-use task at a time, in the background: a start returns at once and the outcome comes from `finished`. */
export class ComputerUseRuns {
  private readonly options: RunsOptions;
  private active: {
    id: string;
    goal: string;
    controller: AbortController;
    finished: Promise<ComputerOutcome>;
  } | null = null;

  constructor(options: RunsOptions) {
    this.options = options;
  }

  get current() {
    return this.active ? { id: this.active.id, goal: this.active.goal } : null;
  }

  start(id: string, task: ComputerTask, session: Session, limits: Limits = {}): StartResult {
    if (this.active) return { ok: false, error: "busy" };
    const controller = new AbortController();
    const watch = this.options.watch?.((reason) => controller.abort(reason)) ?? null;
    try {
      this.options.onStart?.(task);
    } catch (error) {
      this.options.log.warn("computer_use.notice_failed", { error: messageOf(error) });
    }
    const computer = this.options.create(session);
    const finished = computer
      .run(task, { signal: controller.signal, limits, ...(watch ? { watch } : {}) })
      .finally(() => {
        watch?.end();
        if (this.active?.id === id) this.active = null;
      });
    this.active = { id, goal: task.goal, controller, finished };
    return { ok: true, finished };
  }

  /** Stops the task in progress (only `id`, when given) before its next step; false when it is not running. */
  stop(id?: string, reason = "You stopped it."): boolean {
    const run = this.active;
    if (!run || (id !== undefined && run.id !== id)) return false;
    run.controller.abort(reason);
    return true;
  }
}

/** An action as the steering remembers it ("click:0.1.3", "scroll:down", "press:enter"). */
function actionKey(action: ScreenAction): string {
  switch (action.kind) {
    case "click":
    case "type":
      return `${action.kind}:${action.ref}`;
    case "press":
      return `press:${action.key}`;
    case "scroll":
      return `scroll:${action.direction}`;
  }
}

/** A host as people write it and browsers show it: no scheme, no "www.", no path, lower case. */
const hostOf = (address: string) =>
  address
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#:]/)[0] ?? "";

/**
 * Whether a navigation goal's page is not on screen yet: the goal names an address, the screen says which page it
 * shows, and that page is on another host. When the backend cannot read the page (no `url`), the decider's word stands.
 */
export function navigationReached(goal: string, screen: Observation): boolean {
  const target = navigationText(goal);
  if (!target || !screen.url) return false;
  const want = hostOf(target);
  const have = hostOf(screen.url);
  return have === want || have.endsWith(`.${want}`);
}

/** A browser's address bar, by the names Chrome, Edge, Firefox and Safari give it. */
export const ADDRESS_BAR =
  /address and search bar|search or enter address|search with .+ or enter address|address bar|^location$|search or type (a )?(web address|url)|smart search field/i;

export function navigationUnmet(goal: string, screen: Observation): boolean {
  const target = navigationText(goal);
  if (!target) return false;
  // No page reported while the address bar has the focus (Windows leaves it out: the bar then holds what is typed): the
  // page is not known to be there yet, so it is not done.
  if (!screen.url)
    return screen.controls.some(
      (c) => c.role === "textbox" && c.focused === true && ADDRESS_BAR.test(c.label),
    );
  const want = hostOf(target);
  const have = hostOf(screen.url);
  return !(have === want || have.endsWith(`.${want}`));
}

/**
 * The address a navigation goal names, exactly as written: "go to example.com" → "example.com", "open
 * https://example.com/a in Chrome" → that URL. Null for anything else (the decider never writes text: this is the
 * request's own words).
 */
export function navigationText(goal: string): string | null {
  // Never an address inside an email address ("bob@example.com").
  const address = String.raw`(?<![@\w.-])(?:https?:\/\/[^\s"“”'‘’<>]+|(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|tv|app|dev|co|ai|me|edu|gov|uk|de|fr|jp|info|news|blog)(?:\/[^\s"“”'‘’<>]*)?)`;
  // The address right after the verb: "go to example.com", "navigate Chrome to x.com", "take me to x.com"; not "open the
  // email from x.com" (the address is not what is opened).
  const toVerb = String.raw`\b(?:go|navigate|browse|head|get|take\s+me|bring\s+me|switch)(?:\s+\S+){0,3}?\s+to\s+`;
  const openVerb = String.raw`\b(?:open|visit|load|pull\s+up|bring\s+up|show\s+me|launch)\s+`;
  const what = String.raw`(?:the\s+)?(?:(?:web)?site\s+|page\s+|url\s+|address\s+)?`;
  const found = new RegExp(`(?:${toVerb}|${openVerb})${what}(${address})`, "i").exec(goal)?.[1];
  return found ? found.replace(/[.,;:!?)]+$/, "") : null;
}

/** What a screen shows, for telling whether an action changed it: title, page, controls and text. */
export function screenKey(screen: Observation): string {
  return [
    screen.app,
    screen.title,
    screen.url ?? "",
    screen.text ?? "",
    ...screen.controls.map((c) => `${c.role}:${c.label}:${c.value ?? ""}:${c.focused ? 1 : 0}`),
  ].join("\u0001");
}

/** Names the goal quotes: "click the tab ‘Widget library review’" → that title. */
export function quotedTargets(goal: string): string[] {
  const found = [...goal.matchAll(/[“"‘']([^“”"‘’']{3,120})[”"’']/g)].map(
    (match) => match[1]?.trim() ?? "",
  );
  return [...new Set(found)].filter((name) => /[a-z]/i.test(name));
}

const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[“”"‘’']/g, "")
    .trim();
/** A title matches a quoted name exactly, or starts with it (the tab strip adds " – Pinned", " - Memory usage…"). */
const sameName = (title: string, name: string) => {
  const a = normalize(title);
  const b = normalize(name);
  return a === b || a.startsWith(`${b} `) || a.startsWith(`${b}-`) || a.startsWith(`${b} –`);
};

/** A rough sound key, so a name that was heard finds what it sounds like: "school" and "Skool" both become "skl". */
export function soundKey(text: string): string {
  const letters = text
    .toLowerCase()
    .replace(/[^a-z]/g, "")
    .replace(/sch/g, "sk")
    .replace(/ph/g, "f")
    .replace(/ck|ch|q|c(?=[aou]|$)/g, "k")
    .replace(/c/g, "s")
    .replace(/z/g, "s")
    .replace(/x/g, "ks");
  if (!letters) return "";
  return (letters[0] + letters.slice(1).replace(/[aeiouy]/g, "")).replace(/(.)\1+/g, "$1");
}

/** A site's name from its address: "https://www.skool.com/earlyaidopters" → "skool". */
const siteName = (url: string) => {
  try {
    const parts = new URL(url).host.replace(/^www\./, "").split(".");
    return parts.length > 1 ? (parts[parts.length - 2] ?? "") : (parts[0] ?? "");
  } catch {
    return "";
  }
};

/**
 * The one tab a name refers to, before any decision is asked for: by its title (whole, or a word of it), its site
 * ("skool" → skool.com), how it sounds ("school" → Skool), or a tab group's name. Several matches mean it is not
 * clear, and null lets the decision provider choose among the tabs instead.
 */
export function resolveTab(
  names: string[],
  tabs: BrowserTab[],
  groups: TabGroup[] = [],
): { tab: BrowserTab; name: string; via: "title" | "site" | "sound" | "group" } | null {
  for (const name of names) {
    const wanted = normalize(name);
    const key = soundKey(name);
    const words = (tab: BrowserTab) =>
      normalize(tab.title)
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
    const tries: Array<["title" | "site" | "sound", (tab: BrowserTab) => boolean]> = [
      [
        "title",
        (tab) =>
          sameName(tab.title, name) ||
          (wanted.length > 2 && ` ${words(tab).join(" ")} `.includes(` ${wanted} `)),
      ],
      [
        "site",
        (tab) => wanted.length > 2 && siteName(tab.url) === wanted.replace(/[^a-z0-9]/g, ""),
      ],
      [
        "sound",
        (tab) =>
          key.length > 1 &&
          (soundKey(siteName(tab.url)) === key ||
            words(tab).some((word) => soundKey(word) === key)),
      ],
    ];
    for (const [via, test] of tries) {
      const hits = tabs.filter(test);
      const only = hits[0];
      if (hits.length === 1 && only) return { tab: only, name, via };
      if (hits.length > 1) break;
    }
    const group = groups.filter(
      (entry) => normalize(entry.name) === wanted || soundKey(entry.name) === key,
    );
    const found = group[0];
    if (group.length === 1 && found) {
      const inGroup = tabs.filter((tab) => found.tabs.some((title) => sameName(title, tab.title)));
      const tab = inGroup.find((entry) => entry.active) ?? inGroup[0];
      if (tab) return { tab, name, via: "group" };
    }
  }
  return null;
}

/** A tab the goal names without quotes: "switch to the YouTube tab" → "YouTube". */
export function unquotedTabName(goal: string): string | undefined {
  return goal
    .match(/\b(?:to|open|on|in)\s+(?:the\s+)?([A-Z0-9][\w.&'’ -]{1,40}?)\s+tab\b/)?.[1]
    ?.trim();
}

/** A website the goal goes to, by its name: "navigate to youtube.com" → "youtube". */
export function siteNamed(goal: string): string | undefined {
  const found = goal.match(
    /\b(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+)\.(?:com|org|net|io|tv|app|dev|co|ai|me)(?:\.[a-z]{2})?\b/i,
  )?.[1];
  return found ? found.toLowerCase() : undefined;
}

/** Quoted names the goal calls a tab ("the tab labelled 'school'", "the 'school' tab"). */
function tabNames(goal: string): string[] {
  const named = [
    ...goal.matchAll(
      /tab(?:\s+(?:labell?ed|titled|called|named))?\s+[“"‘']([^“”"‘’']{3,120})[”"’']/gi,
    ),
    ...goal.matchAll(/[“"‘']([^“”"‘’']{3,120})[”"’']\s+tab\b/gi),
  ];
  return named.map((match) => match[1]?.trim() ?? "");
}

/** The one on-screen control a quoted name refers to, or null when none or several match. */
function matchControl(controls: ScreenControl[], name: string): ScreenControl | null {
  const matches = controls.filter((control) => sameName(control.label, name));
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

/** A goal that is only going to an address: nothing to do on the page once it is there. */
export function pureNavigation(goal: string): boolean {
  const address = navigationText(goal);
  if (!address) return false;
  const rest = goal.replace(address, " ");
  return !/\b(then|and then|scroll|type|write|send|message|search|find|fill|enter|reply|draft|play|pause|press|watch|mute|click|tap|select|log ?in|sign|buy|order|pay|download|upload|read|copy|paste|book|subscribe|post|share|delete|check)\b/i.test(
    rest,
  );
}

function plainClickGoal(task: ComputerTask) {
  // Going to a site is done when the page is there, not when a tab is clicked (a blank tab once counted as done).
  if (task.text || navigationText(task.goal)) return false;
  const unquoted = task.goal.replace(/[“"‘'][^“”"‘’']{3,120}[”"’']/g, " ");
  return !/\b(then|scroll|type|write|send|message|search|find|fill|enter|reply|draft|play|pause|press|watch|mute)\b/i.test(
    unquoted,
  );
}
