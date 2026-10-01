// Uses T3's desktop-owned, thread-bound preview. Never reads, exports, or copies
// browser cookies; authentication remains in the user's persistent preview.
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import * as NodeTimersPromises from "node:timers/promises";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { PreviewAutomationNoAvailableHostError } from "@t3tools/contracts";
import type {
  PreviewAutomationOperation,
  PreviewAutomationStatus,
  PreviewTabId,
} from "@t3tools/contracts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../mcp/PreviewAutomationBroker.ts";

type Scope = McpInvocationContext.McpInvocationScope;
const isNoAvailableHostError = Schema.is(PreviewAutomationNoAvailableHostError);

export class ChatGPTInteractionRequiredError extends Error {
  readonly startCooldown: boolean;

  constructor(message: string, startCooldown: boolean) {
    super(message);
    this.name = "ChatGPTInteractionRequiredError";
    this.startCooldown = startCooldown;
  }
}

export class SharedBrowserChatGPT {
  private scope: Scope | undefined;
  private readonly tabs = new Map<string, PreviewTabId>();

  setScope(scope: Scope | undefined): void {
    this.scope = scope;
  }

  clearScope(threadId: string): void {
    if (this.scope?.threadId === threadId) {
      this.tabs.delete(this.scope.providerSessionId);
      this.scope = undefined;
    }
  }

  close(): void {
    this.scope = undefined;
    this.tabs.clear();
  }

  private invoke<A>(
    scope: Scope,
    operation: PreviewAutomationOperation,
    input: Record<string, unknown>,
    timeoutMs = 15_000,
  ): Promise<A> {
    return Effect.runPromise(
      PreviewAutomationBroker.invokeActive<A>({ scope, operation, input, timeoutMs }),
    ).catch((error: unknown) => {
      if (isNoAvailableHostError(error))
        throw new ChatGPTInteractionRequiredError(
          "The T3 desktop app is not connected to this environment, so ChatGPT Web cannot open its shared browser. Connect T3 Code desktop to this environment and retry. This did not start a ChatGPT cooldown.",
          false,
        );
      throw error;
    });
  }

  private async tab(scope: Scope, signal: AbortSignal): Promise<PreviewTabId> {
    signal.throwIfAborted();
    const key = scope.providerSessionId;
    const assigned = this.tabs.get(key);
    if (assigned) {
      try {
        const status = await this.invoke<PreviewAutomationStatus>(scope, "status", {
          tabId: assigned,
        });
        if (status.tabId === assigned && status.url?.startsWith("https://chatgpt.com"))
          return assigned;
      } catch {
        // A closed preview tab is recreated below.
      }
      this.tabs.delete(key);
    }

    let current: PreviewAutomationStatus | undefined;
    try {
      current = await this.invoke<PreviewAutomationStatus>(scope, "status", {});
    } catch {
      // No thread tab exists yet.
    }
    if (current?.tabId && current.url?.startsWith("https://chatgpt.com")) {
      this.tabs.set(key, current.tabId);
      return current.tabId;
    }

    const opened = await this.invoke<PreviewAutomationStatus>(
      scope,
      "open",
      { url: "https://chatgpt.com/", open: true, reuseExistingTab: false },
      30_000,
    );
    if (!opened.tabId) throw new Error("T3 shared browser did not open a ChatGPT tab.");
    this.tabs.set(key, opened.tabId);
    return opened.tabId;
  }

  async complete(prompt: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const scope = this.scope;
    if (!scope) throw new Error("Start this request from a T3 thread to use its shared browser.");
    if (!scope.capabilities.has("preview"))
      throw new Error("Enable Agent browser access for this project to use ChatGPT Web.");

    const tabId = await this.tab(scope, signal);
    const invoke = <A>(
      operation: PreviewAutomationOperation,
      input: Record<string, unknown>,
      timeoutMs = 15_000,
    ) => this.invoke<A>(scope, operation, { ...input, tabId }, timeoutMs);

    // Temporary chats keep each request self-contained; the bridge supplies history.
    await invoke(
      "navigate",
      {
        url: "https://chatgpt.com/?temporary-chat=true",
        readiness: "domContentLoaded",
        timeoutMs: 30_000,
      },
      35_000,
    );

    const inspect = () =>
      invoke<{
        readonly composer: boolean;
        readonly login: boolean;
        readonly challenge: boolean;
        readonly assistantCount: number;
        readonly answer: string;
        readonly generating: boolean;
      }>("evaluate", {
        expression: `(() => {
          const body = document.body?.innerText ?? "";
          const title = document.title ?? "";
          const composer = !!document.querySelector('[contenteditable="true"][role="textbox"], #prompt-textarea, textarea');
          const login = !!document.querySelector('[data-testid="login-button"], a[href*="/auth/login"]');
          const challenge = /checking your browser|verify you are human|cloudflare|security check|just a moment|attention required|turnstile/i.test(title + " " + body.slice(0, 1200));
          const answers = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
          const last = answers.at(-1);
          const generating = !!document.querySelector('[data-testid="stop-button"], button[aria-label*="Stop"]');
          return { composer, login, challenge, assistantCount: answers.length, answer: last?.innerText ?? "", generating };
        })()`,
        awaitPromise: true,
        returnByValue: true,
      });

    const ready = await inspect();
    if (ready.challenge)
      throw new ChatGPTInteractionRequiredError(
        "ChatGPT requires verification. Complete it in the visible T3 browser; the request cooldown will apply.",
        true,
      );
    if (ready.login || !ready.composer)
      throw new ChatGPTInteractionRequiredError(
        "Sign in to ChatGPT in the visible T3 browser, then retry this turn.",
        false,
      );

    await invoke("type", { selector: "#prompt-textarea", text: prompt, clear: true });
    signal.throwIfAborted();
    await invoke("press", { key: "Enter", timeoutMs: 15_000 });
    const before = ready.assistantCount;
    const deadline = DateTime.toEpochMillis(DateTime.nowUnsafe()) + 180_000;
    while (DateTime.toEpochMillis(DateTime.nowUnsafe()) < deadline) {
      signal.throwIfAborted();
      await NodeTimersPromises.setTimeout(750, undefined, { signal });
      const state = await inspect();
      if (state.challenge)
        throw new ChatGPTInteractionRequiredError(
          "ChatGPT requested verification. Complete it in the visible T3 browser; the request cooldown will apply.",
          true,
        );
      if (!state.generating && state.assistantCount > before && state.answer.trim())
        return state.answer.trim();
    }
    throw new Error("ChatGPT did not finish a reply within three minutes.");
  }
}
