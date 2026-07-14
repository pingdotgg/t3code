import * as NodeCrypto from "node:crypto";
import {
  EventId,
  type ChatGptBrowserSettings,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProviderSendTurnInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Duration from "effect/Duration";
import * as Stream from "effect/Stream";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { chromium } from "playwright-core";

import { expandHomePath } from "../../pathExpansion.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("chatgpt");
const DEFAULT_CHATGPT_URL = "https://chatgpt.com/";
const RESPONSE_IDLE_MS = 1_500;
const TURN_TIMEOUT_MS = 10 * 60 * 1_000;
const POLL_INTERVAL_MS = 500;

type BrowserEvalElement = {
  innerText?: string;
  textContent?: string | null;
  getAttribute(name: string): string | null;
};

type BrowserEvalDocument = {
  body?: { innerText?: string } | null;
  querySelectorAll(selector: string): ArrayLike<BrowserEvalElement>;
};

type BrowserEvalWindow = {
  getComputedStyle(element: BrowserEvalElement): { display: string; visibility: string };
};

type BrowserHandle =
  | {
      readonly kind: "cdp";
      readonly context: BrowserContext;
      readonly browser: Browser;
    }
  | {
      readonly kind: "persistent";
      readonly context: BrowserContext;
    };

interface ChatGptSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  page: Page;
  readonly browser: BrowserHandle;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeTurnId: TurnId | undefined;
  activeTurnFiber: Fiber.Fiber<void, never> | undefined;
  stopped: boolean;
}

interface ChatGptAdapterOptions {
  readonly instanceId?: ProviderInstanceId;
}

function nowIso(): Effect.Effect<string> {
  return Effect.map(DateTime.now, DateTime.formatIso);
}

function nextEventId(prefix: string): EventId {
  return EventId.make(`${prefix}:${NodeCrypto.randomUUID()}`);
}

function nextTurnId(): TurnId {
  return TurnId.make(`chatgpt-turn-${NodeCrypto.randomUUID()}`);
}

function nextRuntimeItemId(prefix: string): RuntimeItemId {
  return RuntimeItemId.make(`${prefix}:${NodeCrypto.randomUUID()}`);
}

function normalizeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message.trim();
  return String(error);
}

function nonEmpty(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function isChatGptHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "chatgpt.com" || normalized.endsWith(".chatgpt.com");
}

function isChatGptPageUrl(value: string): boolean {
  try {
    return isChatGptHostname(new URL(value).hostname);
  } catch {
    return false;
  }
}

function readResumeUrl(resumeCursor: unknown): string | undefined {
  if (typeof resumeCursor === "string") return nonEmpty(resumeCursor);
  if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) {
    return undefined;
  }
  const url = (resumeCursor as { readonly url?: unknown }).url;
  return typeof url === "string" ? nonEmpty(url) : undefined;
}

function makeResumeCursor(page: Page): { readonly version: 1; readonly url: string } {
  return { version: 1, url: page.url() };
}

async function pageInnerText(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const doc = (globalThis as unknown as { document: BrowserEvalDocument }).document;
    return doc.body?.innerText ?? "";
  });
}

async function findPromptLocator(page: Page) {
  const candidates = [
    page.locator('[data-testid="prompt-textarea"]').last(),
    page.locator("#prompt-textarea").last(),
    page.locator('textarea[placeholder*="Message"]').last(),
    page.locator("textarea").last(),
    page.locator('[contenteditable="true"]').last(),
    page.getByRole("textbox").last(),
  ];

  for (const candidate of candidates) {
    try {
      if ((await candidate.count()) > 0 && (await candidate.isVisible({ timeout: 500 }))) {
        return candidate;
      }
    } catch {
      // Try the next selector; ChatGPT changes markup frequently.
    }
  }
  return undefined;
}

async function clickSendOrPressEnter(page: Page): Promise<void> {
  const sendCandidates = [
    page.locator('[data-testid="send-button"]').last(),
    page.getByRole("button", { name: /send/i }).last(),
    page.locator('button[aria-label*="Send" i]').last(),
  ];

  for (const candidate of sendCandidates) {
    try {
      if ((await candidate.count()) > 0 && (await candidate.isVisible({ timeout: 500 }))) {
        await candidate.click({ timeout: 1_000 });
        return;
      }
    } catch {
      // Fall back to Enter.
    }
  }

  await page.keyboard.press("Enter");
}

async function submitPrompt(page: Page, prompt: string): Promise<void> {
  const promptLocator = await findPromptLocator(page);
  if (!promptLocator) {
    throw new Error(
      "Could not find the ChatGPT prompt textbox. Make sure chatgpt.com is loaded and you are signed in.",
    );
  }

  await promptLocator.click({ timeout: 5_000 });
  await promptLocator.fill(prompt, { timeout: 10_000 });
  await clickSendOrPressEnter(page);
}

async function latestAssistantText(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const doc = (globalThis as unknown as { document: BrowserEvalDocument }).document;
    const win = (globalThis as unknown as { window: BrowserEvalWindow }).window;
    const visibleText = (element: BrowserEvalElement): string => {
      const style = win.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") return "";
      return element.innerText?.trim() ?? "";
    };

    const roleNodes = Array.from(doc.querySelectorAll('[data-message-author-role="assistant"]'));
    const roleTexts = roleNodes.map(visibleText).filter(Boolean);
    if (roleTexts.length > 0) return roleTexts[roleTexts.length - 1] ?? "";

    const markdownNodes = Array.from(doc.querySelectorAll(".markdown"));
    const markdownTexts = markdownNodes.map(visibleText).filter(Boolean);
    if (markdownTexts.length > 0) return markdownTexts[markdownTexts.length - 1] ?? "";

    const articleNodes = Array.from(doc.querySelectorAll("article"));
    const assistantArticles = articleNodes
      .map(visibleText)
      .filter((text) => text.length > 0 && !/^You said:/i.test(text));
    return assistantArticles[assistantArticles.length - 1] ?? "";
  });
}

async function isGenerating(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const doc = (globalThis as unknown as { document: BrowserEvalDocument }).document;
    const labels = Array.from(doc.querySelectorAll("button"))
      .map((button) => `${button.getAttribute("aria-label") ?? ""} ${button.textContent ?? ""}`)
      .join("\n")
      .toLowerCase();
    return labels.includes("stop generating") || labels.includes("stop streaming");
  });
}

async function clickStop(page: Page): Promise<void> {
  const candidates = [
    page.getByRole("button", { name: /stop/i }).last(),
    page.locator('button[aria-label*="Stop" i]').last(),
  ];
  for (const candidate of candidates) {
    try {
      if ((await candidate.count()) > 0 && (await candidate.isVisible({ timeout: 500 }))) {
        await candidate.click({ timeout: 1_000 });
        return;
      }
    } catch {
      // Try next stop selector.
    }
  }
}

function chatGptTargetUrl(settings: ChatGptBrowserSettings, resumeCursor: unknown): string {
  return readResumeUrl(resumeCursor) ?? nonEmpty(settings.conversationUrl) ?? DEFAULT_CHATGPT_URL;
}

async function resolveBrowser(settings: ChatGptBrowserSettings): Promise<BrowserHandle> {
  const executablePath = nonEmpty(settings.browserExecutablePath);
  if (executablePath) {
    const context = await chromium.launchPersistentContext(expandHomePath(settings.userDataDir), {
      executablePath: expandHomePath(executablePath),
      headless: settings.headless,
    });
    return { kind: "persistent", context };
  }

  const browser = await chromium.connectOverCDP(settings.cdpEndpoint.trim());
  const context = browser.contexts()[0] ?? (await browser.newContext());
  return { kind: "cdp", context, browser };
}

async function resolvePage(settings: ChatGptBrowserSettings, browser: BrowserHandle, url: string) {
  const pages = browser.context.pages();
  const resumeMatch = pages.find((page) => page.url() === url);
  if (resumeMatch) return resumeMatch;

  if (!settings.newConversationPerThread) {
    const existingChatGpt = pages.find((page) => isChatGptPageUrl(page.url()));
    if (existingChatGpt) return existingChatGpt;
  }

  const page = await browser.context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  return page;
}

async function cleanupBrowser(browser: BrowserHandle): Promise<void> {
  if (browser.kind === "persistent") {
    await browser.context.close().catch(() => undefined);
    return;
  }

  await browser.browser.close().catch(() => undefined);
}

function unsupported(operation: string) {
  return new ProviderAdapterValidationError({
    provider: PROVIDER,
    operation,
    issue:
      "The ChatGPT browser connector is a prompt/response bridge only. This provider operation is not supported.",
  });
}

function attachmentNote(input: ProviderSendTurnInput): string {
  const attachments = input.attachments ?? [];
  if (attachments.length === 0) return "";
  const labels = attachments
    .map((attachment, index) => {
      const name = "name" in attachment ? attachment.name : undefined;
      return typeof name === "string" && name.trim().length > 0
        ? `${index + 1}. ${name.trim()}`
        : `${index + 1}. attachment ${index + 1}`;
    })
    .join("\n");
  return `\n\n[SergeCode note: ${attachments.length} attachment(s) were included in the original turn, but the ChatGPT browser connector cannot upload them yet. Attachment labels:\n${labels}]`;
}

export const makeChatGptBrowserAdapter = Effect.fn("makeChatGptBrowserAdapter")(function* (
  settings: ChatGptBrowserSettings,
  options?: ChatGptAdapterOptions,
) {
  const instanceId = options?.instanceId ?? ProviderInstanceId.make("chatgpt");
  const runtimeEventPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<ProviderRuntimeEvent>(),
    PubSub.shutdown,
  );
  const sessions = new Map<ThreadId, ChatGptSessionContext>();
  const adapterScope = yield* Effect.scope;

  const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
    PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

  const eventBase = (
    threadId: ThreadId,
    input?: { readonly turnId?: TurnId; readonly itemId?: RuntimeItemId },
  ) =>
    Effect.map(nowIso(), (createdAt) => ({
      eventId: nextEventId("chatgpt"),
      provider: PROVIDER,
      providerInstanceId: instanceId,
      threadId,
      createdAt,
      ...(input?.turnId ? { turnId: input.turnId } : {}),
      ...(input?.itemId ? { itemId: input.itemId } : {}),
    }));

  const emitAssistantStarted = (threadId: ThreadId, turnId: TurnId, itemId: RuntimeItemId) =>
    Effect.gen(function* () {
      yield* offerRuntimeEvent({
        ...(yield* eventBase(threadId, { turnId, itemId })),
        type: "item.started",
        payload: {
          itemType: "assistant_message",
          status: "inProgress",
          title: "ChatGPT response",
        },
      });
    });

  const emitAssistantCompleted = (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly itemId: RuntimeItemId;
    readonly status: "completed" | "failed";
    readonly title: string;
    readonly detail?: string;
    readonly text?: string;
  }) =>
    Effect.gen(function* () {
      yield* offerRuntimeEvent({
        ...(yield* eventBase(input.threadId, { turnId: input.turnId, itemId: input.itemId })),
        type: "item.completed",
        payload: {
          itemType: "assistant_message",
          status: input.status,
          title: input.title,
          ...(input.detail ? { detail: input.detail } : {}),
          ...(input.text !== undefined ? { data: { text: input.text } } : {}),
        },
      });
    });

  const deleteSessionIfCurrent = (threadId: ThreadId, session: ChatGptSessionContext): void => {
    if (sessions.get(threadId) === session) {
      sessions.delete(threadId);
    }
  };

  const requireSession = (threadId: ThreadId) => {
    const session = sessions.get(threadId);
    if (!session || session.stopped) {
      return Effect.fail(
        new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        }),
      );
    }
    return Effect.succeed(session);
  };

  const runTurn = (
    session: ChatGptSessionContext,
    input: ProviderSendTurnInput,
    turnId: TurnId,
    assistantItemId: RuntimeItemId,
    userItemId: RuntimeItemId,
  ): Effect.Effect<void> => {
    let activeAssistantItemId = assistantItemId;
    return Effect.gen(function* () {
      const prompt = `${input.input ?? ""}${attachmentNote(input)}`;
      yield* offerRuntimeEvent({
        ...(yield* eventBase(session.threadId, { turnId })),
        type: "turn.started",
        payload: input.modelSelection?.model ? { model: input.modelSelection.model } : {},
      });
      yield* offerRuntimeEvent({
        ...(yield* eventBase(session.threadId, { turnId, itemId: userItemId })),
        type: "item.completed",
        payload: {
          itemType: "user_message",
          status: "completed",
          title: "User message",
          detail: prompt.slice(0, 500),
          data: { text: prompt },
        },
      });
      yield* emitAssistantStarted(session.threadId, turnId, assistantItemId);

      yield* Effect.tryPromise({
        try: () => submitPrompt(session.page, prompt),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "chatgpt.browser.submitPrompt",
            detail: normalizeError(cause),
            cause,
          }),
      });

      let previousText = "";
      let completedText = "";
      let lastChangedAt = Date.now();
      const startedAt = Date.now();

      while (Date.now() - startedAt < TURN_TIMEOUT_MS) {
        const text = yield* Effect.tryPromise({
          try: () => latestAssistantText(session.page),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "chatgpt.browser.readResponse",
              detail: normalizeError(cause),
              cause,
            }),
        });
        if (text.length > previousText.length && text.startsWith(previousText)) {
          const delta = text.slice(previousText.length);
          previousText = text;
          completedText = text;
          lastChangedAt = Date.now();
          yield* offerRuntimeEvent({
            ...(yield* eventBase(session.threadId, { turnId, itemId: activeAssistantItemId })),
            type: "content.delta",
            payload: { streamKind: "assistant_text", delta },
          });
        } else if (text !== previousText) {
          yield* emitAssistantCompleted({
            threadId: session.threadId,
            turnId,
            itemId: activeAssistantItemId,
            status: "completed",
            title: "ChatGPT response rerendered",
          });
          activeAssistantItemId = nextRuntimeItemId("chatgpt-assistant");
          yield* emitAssistantStarted(session.threadId, turnId, activeAssistantItemId);
          previousText = text;
          completedText = text;
          lastChangedAt = Date.now();
          yield* offerRuntimeEvent({
            ...(yield* eventBase(session.threadId, { turnId, itemId: activeAssistantItemId })),
            type: "content.delta",
            payload: { streamKind: "assistant_text", delta: text },
          });
        }

        const generating = yield* Effect.promise(() =>
          isGenerating(session.page).catch(() => false),
        );
        if (
          !generating &&
          completedText.trim().length > 0 &&
          Date.now() - lastChangedAt >= RESPONSE_IDLE_MS
        ) {
          break;
        }
        yield* Effect.sleep(Duration.millis(POLL_INTERVAL_MS));
      }

      if (completedText.trim().length === 0) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "chatgpt.browser.waitForResponse",
          detail:
            "Timed out waiting for a ChatGPT response. The browser may be logged out, blocked by a modal, or still generating.",
        });
      }

      const turn = session.turns.find((candidate) => candidate.id === turnId);
      turn?.items.push({ type: "user", text: prompt }, { type: "assistant", text: completedText });
      session.session = {
        ...session.session,
        status: "ready",
        activeTurnId: undefined,
        resumeCursor: makeResumeCursor(session.page),
        updatedAt: yield* nowIso(),
      };
      session.activeTurnId = undefined;

      yield* emitAssistantCompleted({
        threadId: session.threadId,
        turnId,
        itemId: activeAssistantItemId,
        status: "completed",
        title: "ChatGPT response",
        text: completedText,
      });
      yield* offerRuntimeEvent({
        ...(yield* eventBase(session.threadId, { turnId })),
        type: "turn.completed",
        payload: { state: "completed", stopReason: "stop" },
      });
    }).pipe(
      Effect.catch((error: ProviderAdapterError) =>
        Effect.gen(function* () {
          session.session = {
            ...session.session,
            status: "error",
            activeTurnId: undefined,
            lastError: error.message,
            updatedAt: yield* nowIso(),
          };
          session.activeTurnId = undefined;
          yield* emitAssistantCompleted({
            threadId: session.threadId,
            turnId,
            itemId: activeAssistantItemId,
            status: "failed",
            title: "ChatGPT response failed",
            detail: error.message,
          });
          yield* offerRuntimeEvent({
            ...(yield* eventBase(session.threadId, { turnId })),
            type: "turn.completed",
            payload: { state: "failed", errorMessage: error.message },
          });
        }),
      ),
    );
  };

  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      Array.from(sessions.values()),
      (session) =>
        Effect.gen(function* () {
          if (session.activeTurnFiber) {
            yield* Fiber.interrupt(session.activeTurnFiber).pipe(Effect.ignore);
          }
          yield* Effect.promise(() => cleanupBrowser(session.browser));
        }),
      { discard: true },
    ),
  );

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "unsupported" },
    startSession: (input) =>
      Effect.gen(function* () {
        const existing = sessions.get(input.threadId);
        if (existing && !existing.stopped) return existing.session;

        const browser = yield* Effect.tryPromise({
          try: () => resolveBrowser(settings),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "chatgpt.browser.connect",
              detail: normalizeError(cause),
              cause,
            }),
        });
        const targetUrl = chatGptTargetUrl(settings, input.resumeCursor);
        const page = yield* Effect.tryPromise({
          try: () => resolvePage(settings, browser, targetUrl),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "chatgpt.browser.openPage",
              detail: normalizeError(cause),
              cause,
            }),
        });

        const bodyText = yield* Effect.promise(() => pageInnerText(page).catch(() => ""));
        if (
          /log in|sign up|stay logged out/i.test(bodyText) &&
          !/message chatgpt|ask anything/i.test(bodyText)
        ) {
          yield* Effect.logWarning("ChatGPT browser page may not be authenticated", {
            threadId: input.threadId,
            url: page.url(),
          });
        }

        const createdAt = yield* nowIso();
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: instanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          model: input.modelSelection?.model ?? "chatgpt",
          threadId: input.threadId,
          resumeCursor: makeResumeCursor(page),
          createdAt,
          updatedAt: createdAt,
        };
        sessions.set(input.threadId, {
          threadId: input.threadId,
          session,
          page,
          browser,
          turns: [],
          activeTurnId: undefined,
          activeTurnFiber: undefined,
          stopped: false,
        });
        yield* offerRuntimeEvent({
          ...(yield* eventBase(input.threadId)),
          type: "session.started",
          payload: { message: "Connected to ChatGPT in a browser." },
        });
        yield* offerRuntimeEvent({
          ...(yield* eventBase(input.threadId)),
          type: "thread.started",
          payload: { providerThreadId: page.url() },
        });
        return session;
      }),
    sendTurn: (input) =>
      Effect.gen(function* () {
        const session = yield* requireSession(input.threadId);
        if (session.activeTurnId !== undefined) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "ChatGPT browser connector already has a turn in progress for this thread.",
          });
        }

        const turnId = nextTurnId();
        const assistantItemId = nextRuntimeItemId("chatgpt-assistant");
        const userItemId = nextRuntimeItemId("chatgpt-user");
        session.activeTurnId = turnId;
        session.session = {
          ...session.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt: yield* nowIso(),
        };
        session.turns.push({ id: turnId, items: [] });
        session.activeTurnFiber = yield* runTurn(
          session,
          input,
          turnId,
          assistantItemId,
          userItemId,
        ).pipe(Effect.forkIn(adapterScope));
        return { threadId: input.threadId, turnId, resumeCursor: makeResumeCursor(session.page) };
      }),
    interruptTurn: (threadId, turnId) =>
      Effect.gen(function* () {
        const session = yield* requireSession(threadId);
        if (turnId !== undefined && session.activeTurnId !== turnId) return;
        yield* Effect.tryPromise({
          try: () => clickStop(session.page),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "chatgpt.browser.stop",
              detail: normalizeError(cause),
              cause,
            }),
        });
      }),
    stopTask: () => Effect.fail(unsupported("stopTask")),
    respondToRequest: () => Effect.fail(unsupported("respondToRequest")),
    respondToUserInput: () => Effect.fail(unsupported("respondToUserInput")),
    stopSession: (threadId) =>
      Effect.gen(function* () {
        const session = sessions.get(threadId);
        if (!session) return;
        session.stopped = true;
        if (session.activeTurnFiber) {
          yield* Fiber.interrupt(session.activeTurnFiber).pipe(Effect.ignore);
        }
        yield* Effect.promise(() => cleanupBrowser(session.browser));
        deleteSessionIfCurrent(threadId, session);
        yield* offerRuntimeEvent({
          ...(yield* eventBase(threadId)),
          type: "session.exited",
          payload: { reason: "stopped", exitKind: "graceful" },
        });
      }),
    listSessions: () =>
      Effect.succeed(Array.from(sessions.values()).map((session) => session.session)),
    hasSession: (threadId) =>
      Effect.succeed(Boolean(sessions.get(threadId) && !sessions.get(threadId)?.stopped)),
    readThread: (threadId) =>
      Effect.gen(function* () {
        const session = yield* requireSession(threadId);
        return {
          threadId,
          turns: session.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
        };
      }),
    rollbackThread: (threadId) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "ChatGPT browser conversations cannot be rolled back from SergeCode.",
        });
      }),
    stopAll: () =>
      Effect.forEach(Array.from(sessions.keys()), (threadId) =>
        Effect.gen(function* () {
          const session = sessions.get(threadId);
          if (!session) return;
          session.stopped = true;
          if (session.activeTurnFiber) {
            yield* Fiber.interrupt(session.activeTurnFiber).pipe(Effect.ignore);
          }
          yield* Effect.promise(() => cleanupBrowser(session.browser));
          deleteSessionIfCurrent(threadId, session);
        }),
      ).pipe(Effect.asVoid),
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  } satisfies ProviderAdapterShape<ProviderAdapterError>;
});
