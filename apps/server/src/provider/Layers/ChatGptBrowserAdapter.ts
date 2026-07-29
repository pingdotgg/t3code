import * as NodeCrypto from "node:crypto";
import {
  EventId,
  type CanonicalRequestType,
  type ChatGptBrowserSettings,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type ProviderSendTurnInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Duration from "effect/Duration";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { chromium } from "playwright-core";

import {
  startCloudflaredTunnel,
  type CloudflaredTunnelHandle,
} from "../../mcp/CloudflaredTunnel.ts";
import { buildConnectorUrl } from "../../mcp/McpConnectorUrl.ts";
import { workspaceCapabilitiesForAccess } from "../../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import { startMcpTunnelProxy } from "../../mcp/McpTunnelProxy.ts";
import {
  registerWorkspaceApprovalChannel,
  resolveWorkspaceApproval,
  unregisterWorkspaceApprovalChannel,
} from "../../mcp/toolkits/workspace/WorkspaceApprovalBroker.ts";
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
  workspaceProviderSessionId: string | undefined;
  /**
   * Set when a workspace connector was issued and the model has not yet been
   * told about it. Cleared after the first turn carries the preamble, so the
   * instruction is sent once per conversation rather than on every message.
   */
  pendingWorkspacePreamble: boolean;
}

interface ChatGptAdapterOptions {
  readonly instanceId?: ProviderInstanceId;
}

interface IssuedWorkspaceConnector {
  readonly url: string;
  readonly providerSessionId: string;
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

/**
 * The message shown in the thread when a workspace connector is available.
 *
 * ChatGPT's Developer Mode connectors are registered once in account
 * settings, not per conversation, so this cannot be automated away — the user
 * pastes the URL once and every later thread reuses the registered connector.
 * The instructions live in the timeline rather than in docs because that is
 * where the user is when the URL first exists.
 */
export function connectorSetupMessage(
  connectorUrl: string,
  access: ChatGptBrowserSettings["workspaceBridgeAccess"],
): string {
  const capability =
    access === "full"
      ? "It can read the repository, edit files, apply patches, and run shell commands"
      : access === "write"
        ? "It can read the repository, edit files, and apply patches"
        : "It can read files, search, and show uncommitted changes — it cannot write or run commands";
  const approvalNote =
    access === "read"
      ? ""
      : " Edits and commands follow this thread's runtime mode: in Approvals mode each one appears as an approval card here before anything happens.";
  return [
    "**Workspace connector ready.**",
    "",
    "This thread can give ChatGPT access to its repository. In ChatGPT: Settings → Connectors → add a connector with **No authentication** and this Server URL:",
    "",
    "```",
    connectorUrl,
    "```",
    "",
    `The URL carries a credential scoped to this thread only. ${capability}, and it cannot reach any other project.${approvalNote} Revoke it by ending this session.`,
  ].join("\n");
}

/**
 * Prompt preamble that points the model at the connector on the first turn.
 *
 * Without it the model answers from the prompt text alone and never calls the
 * tools, because nothing in a fresh conversation suggests the repository is
 * reachable. Sent once per session, not per turn, so it does not accumulate.
 */
export function workspacePreamble(access: ChatGptBrowserSettings["workspaceBridgeAccess"]): string {
  const mutationSentence =
    access === "full"
      ? "You can change the repository with `workspace_write`, `workspace_edit`, and `workspace_patch`. Public shell execution is disabled until SergeCode can enforce an OS-level workspace sandbox. A mutation may return status pending-approval — the user is deciding in SergeCode; poll `workspace_wait` with the operationId instead of re-submitting."
      : access === "write"
        ? "You can change the repository with `workspace_write`, `workspace_edit`, and `workspace_patch` (no shell access). A mutation may return status pending-approval — the user is deciding in SergeCode; poll `workspace_wait` with the operationId instead of re-submitting."
        : "The connector is read-only: propose changes as diffs or instructions rather than trying to apply them.";
  return [
    "[SergeCode] You are connected to a local repository through the SergeCode workspace connector.",
    "Call `workspace_overview` first to see the project, then use `workspace_tree`, `workspace_read`, `workspace_search`, and `workspace_changes` to ground your answers in the real code.",
    mutationSentence,
  ].join(" ");
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
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  /**
   * Managed-tunnel state, started lazily on the first session that needs it.
   *
   * Lazy because the MCP port is only knowable from an issued credential's
   * endpoint (the HTTP server may not be listening yet when this adapter is
   * constructed), and because a tunnel that nobody's session ever asked for
   * should not exist. The handle is dropped when its URL dies so the next
   * session retries instead of permanently advertising nothing.
   */
  let tunnel: CloudflaredTunnelHandle | null = null;
  const tunnelSemaphore = yield* Semaphore.make(1);

  const managedTunnelUrl = (localMcpEndpoint: string): Effect.Effect<string | undefined> =>
    tunnelSemaphore.withPermit(
      Effect.gen(function* () {
        if (settings.connectorTunnel !== "cloudflared") return undefined;
        if (tunnel !== null) {
          const current = yield* tunnel.publicUrl;
          if (current !== undefined) return current;
          tunnel = null;
        }
        const mcpPort = Number(new URL(localMcpEndpoint).port);
        if (!Number.isInteger(mcpPort) || mcpPort <= 0) return undefined;
        const proxy = yield* startMcpTunnelProxy({ upstreamPort: mcpPort }).pipe(
          Effect.provideService(Scope.Scope, adapterScope),
          Effect.catch((error) =>
            Effect.logWarning("Could not start the MCP tunnel proxy", {
              error: String(error),
            }).pipe(Effect.as(undefined)),
          ),
        );
        if (proxy === undefined) return undefined;
        const handle = yield* startCloudflaredTunnel({ localPort: proxy.port }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(Scope.Scope, adapterScope),
        );
        tunnel = handle;
        return yield* handle.publicUrl;
      }),
    );

  const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
    PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

  const eventBase = (
    threadId: ThreadId,
    input?: {
      readonly turnId?: TurnId;
      readonly itemId?: RuntimeItemId;
      readonly requestId?: RuntimeRequestId;
    },
  ) =>
    Effect.map(nowIso(), (createdAt) => ({
      eventId: nextEventId("chatgpt"),
      provider: PROVIDER,
      providerInstanceId: instanceId,
      threadId,
      createdAt,
      ...(input?.turnId ? { turnId: input.turnId } : {}),
      ...(input?.itemId ? { itemId: input.itemId } : {}),
      ...(input?.requestId ? { requestId: input.requestId } : {}),
    }));

  /**
   * The approval channel handed to the workspace broker. Approval events must
   * come from this adapter's own event stream because the identity fields
   * (provider, instance, thread, and the turn currently on screen) live here;
   * the broker only knows the question and the eventual answer.
   */
  const makeWorkspaceApprovalChannel = (threadId: ThreadId) => ({
    emitOpened: (input: {
      readonly requestId: string;
      readonly requestType: CanonicalRequestType;
      readonly detail: string;
    }) =>
      Effect.gen(function* () {
        const session = sessions.get(threadId);
        const base = yield* eventBase(threadId, {
          requestId: RuntimeRequestId.make(input.requestId),
          ...(session?.activeTurnId ? { turnId: session.activeTurnId } : {}),
        });
        yield* offerRuntimeEvent({
          ...base,
          type: "request.opened",
          payload: { requestType: input.requestType, detail: input.detail },
        });
      }),
    emitResolved: (input: {
      readonly requestId: string;
      readonly requestType: CanonicalRequestType;
      readonly decision: ProviderApprovalDecision;
    }) =>
      Effect.gen(function* () {
        const session = sessions.get(threadId);
        const base = yield* eventBase(threadId, {
          requestId: RuntimeRequestId.make(input.requestId),
          ...(session?.activeTurnId ? { turnId: session.activeTurnId } : {}),
        });
        yield* offerRuntimeEvent({
          ...base,
          type: "request.resolved",
          payload: { requestType: input.requestType, decision: input.decision },
        });
      }),
  });

  const emitAssistantStarted = (threadId: ThreadId, turnId: TurnId, itemId: RuntimeItemId) =>
    eventBase(threadId, { turnId, itemId }).pipe(
      Effect.flatMap((base) =>
        offerRuntimeEvent({
          ...base,
          type: "item.started",
          payload: {
            itemType: "assistant_message",
            status: "inProgress",
            title: "ChatGPT response",
          },
        }),
      ),
    );

  const emitAssistantCompleted = (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly itemId: RuntimeItemId;
    readonly status: "completed" | "failed";
    readonly title: string;
    readonly detail?: string;
    readonly text?: string;
  }) =>
    eventBase(input.threadId, { turnId: input.turnId, itemId: input.itemId }).pipe(
      Effect.flatMap((base) =>
        offerRuntimeEvent({
          ...base,
          type: "item.completed",
          payload: {
            itemType: "assistant_message",
            status: input.status,
            title: input.title,
            ...(input.detail ? { detail: input.detail } : {}),
            ...(input.text !== undefined ? { data: { text: input.text } } : {}),
          },
        }),
      ),
    );

  /**
   * Mints this thread's read-only workspace connector, or `undefined` when
   * the bridge is off or no public address is configured.
   *
   * A loopback endpoint is deliberately not advertised: OpenAI's backend
   * dials the connector, so a `127.0.0.1` URL would be accepted in the
   * settings UI and then silently fail on every tool call. Better to show no
   * connector than a broken one.
   */
  const issueWorkspaceConnector = (
    threadId: ThreadId,
  ): Effect.Effect<IssuedWorkspaceConnector | undefined> =>
    Effect.gen(function* () {
      if (!settings.workspaceBridge) return undefined;

      const credential = yield* McpSessionRegistry.issueActiveWorkspaceConnector({
        threadId,
        providerInstanceId: instanceId,
        capabilities: workspaceCapabilitiesForAccess(settings.workspaceBridgeAccess),
      });
      if (!credential) return undefined;

      // Manual address wins: a user who configured a stable hostname wants
      // that hostname, not whatever the managed tunnel scraped this boot.
      const publicBaseUrl =
        nonEmpty(settings.publicBaseUrl) ?? (yield* managedTunnelUrl(credential.config.endpoint));
      if (!publicBaseUrl) {
        yield* McpSessionRegistry.revokeActiveMcpProviderSession(
          credential.config.providerSessionId,
        );
        return undefined;
      }
      const url = buildConnectorUrl({ publicBaseUrl, token: credential.token });
      if (!url) {
        yield* McpSessionRegistry.revokeActiveMcpProviderSession(
          credential.config.providerSessionId,
        );
        return undefined;
      }
      return { url, providerSessionId: credential.config.providerSessionId };
    }).pipe(
      // A connector is an enhancement, not a precondition for chatting. If
      // issuance fails the session still starts as a plain prompt bridge.
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not issue a ChatGPT workspace connector", {
          threadId,
          cause,
        }).pipe(Effect.as(undefined)),
      ),
    );

  const deleteSessionIfCurrent = (threadId: ThreadId, session: ChatGptSessionContext): void => {
    if (sessions.get(threadId) === session) {
      sessions.delete(threadId);
    }
  };

  const revokeWorkspaceConnector = (session: ChatGptSessionContext) =>
    session.workspaceProviderSessionId === undefined
      ? Effect.void
      : McpSessionRegistry.revokeActiveMcpProviderSession(session.workspaceProviderSessionId).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              session.workspaceProviderSessionId = undefined;
            }),
          ),
        );

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
      const preamble = session.pendingWorkspacePreamble
        ? `${workspacePreamble(settings.workspaceBridgeAccess)}\n\n`
        : "";
      session.pendingWorkspacePreamble = false;
      const prompt = `${preamble}${input.input ?? ""}${attachmentNote(input)}`;
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
      let lastChangedAt = yield* Clock.currentTimeMillis;
      const startedAt = lastChangedAt;

      while ((yield* Clock.currentTimeMillis) - startedAt < TURN_TIMEOUT_MS) {
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
          lastChangedAt = yield* Clock.currentTimeMillis;
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
          lastChangedAt = yield* Clock.currentTimeMillis;
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
          (yield* Clock.currentTimeMillis) - lastChangedAt >= RESPONSE_IDLE_MS
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
          yield* revokeWorkspaceConnector(session);
          yield* unregisterWorkspaceApprovalChannel(session.threadId);
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
        const connectorUrl = yield* issueWorkspaceConnector(input.threadId);
        sessions.set(input.threadId, {
          threadId: input.threadId,
          session,
          page,
          browser,
          turns: [],
          activeTurnId: undefined,
          activeTurnFiber: undefined,
          stopped: false,
          pendingWorkspacePreamble: connectorUrl !== undefined,
          workspaceProviderSessionId: connectorUrl?.providerSessionId,
        });
        // Register even when no connector URL exists: a stale connector from
        // an earlier session of this thread may still hold a valid token, and
        // its approval requests must land somewhere rather than erroring.
        registerWorkspaceApprovalChannel(
          input.threadId,
          makeWorkspaceApprovalChannel(input.threadId),
        );
        yield* offerRuntimeEvent({
          ...(yield* eventBase(input.threadId)),
          type: "session.started",
          payload: { message: "Connected to ChatGPT in a browser." },
        });
        if (connectorUrl !== undefined) {
          const connectorItemId = nextRuntimeItemId("chatgpt-connector");
          yield* offerRuntimeEvent({
            ...(yield* eventBase(input.threadId, { itemId: connectorItemId })),
            type: "item.completed",
            payload: {
              itemType: "assistant_message",
              status: "completed",
              title: "Workspace connector",
              data: {
                text: connectorSetupMessage(connectorUrl.url, settings.workspaceBridgeAccess),
              },
            },
          });
        }
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
    respondToRequest: (threadId, requestId, decision) =>
      Effect.gen(function* () {
        // The only approvals a ChatGPT session raises are workspace-bridge
        // mutations, routed through the broker. An unknown id means the
        // request already resolved or never existed.
        const handled = yield* resolveWorkspaceApproval(threadId, requestId, decision);
        if (!handled) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "respondToRequest",
            issue: `No pending workspace approval ${requestId} for this thread.`,
          });
        }
      }),
    respondToUserInput: () => Effect.fail(unsupported("respondToUserInput")),
    stopSession: (threadId) =>
      Effect.gen(function* () {
        const session = sessions.get(threadId);
        if (!session) return;
        session.stopped = true;
        yield* revokeWorkspaceConnector(session);
        yield* unregisterWorkspaceApprovalChannel(threadId);
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
          yield* revokeWorkspaceConnector(session);
          yield* unregisterWorkspaceApprovalChannel(threadId);
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
