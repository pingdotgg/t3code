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

interface ChatGPTReplyObservation {
  readonly assistantCount: number;
  readonly answer: string;
  readonly generating: boolean;
}

export function isChatGPTReplyComplete(
  observation: ChatGPTReplyObservation,
  previousAssistantCount: number,
): boolean {
  return (
    observation.assistantCount > previousAssistantCount &&
    observation.answer.trim().length > 0 &&
    !observation.generating
  );
}

export function hasChatGPTLockdownCheckFailure(text: string): boolean {
  return /couldn['’]t check lockdown mode/i.test(text);
}

export function isChatGPTPromptAccepted(
  userMessageCount: number,
  previousUserMessageCount: number,
) {
  return userMessageCount > previousUserMessageCount;
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

  private async tab(
    scope: Scope,
    signal: AbortSignal,
  ): Promise<{ readonly tabId: PreviewTabId; readonly needsNavigation: boolean }> {
    signal.throwIfAborted();
    const key = scope.providerSessionId;
    const assigned = this.tabs.get(key);
    if (assigned) {
      try {
        const status = await this.invoke<PreviewAutomationStatus>(scope, "status", {
          tabId: assigned,
        });
        if (status.tabId === assigned && status.url?.startsWith("https://chatgpt.com"))
          return { tabId: assigned, needsNavigation: true };
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
      return { tabId: current.tabId, needsNavigation: true };
    }

    const opened = await this.invoke<PreviewAutomationStatus>(
      scope,
      "open",
      {
        url: "https://chatgpt.com/?temporary-chat=true",
        open: true,
        reuseExistingTab: false,
      },
      30_000,
    );
    if (!opened.tabId) throw new Error("T3 shared browser did not open a ChatGPT tab.");
    this.tabs.set(key, opened.tabId);
    return { tabId: opened.tabId, needsNavigation: false };
  }

  async complete(prompt: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const scope = this.scope;
    if (!scope) throw new Error("Start this request from a T3 thread to use its shared browser.");
    if (!scope.capabilities.has("preview"))
      throw new Error("Enable Agent browser access for this project to use ChatGPT Web.");

    const { tabId, needsNavigation } = await this.tab(scope, signal);
    const invoke = <A>(
      operation: PreviewAutomationOperation,
      input: Record<string, unknown>,
      timeoutMs = 15_000,
    ) => this.invoke<A>(scope, operation, { ...input, tabId }, timeoutMs);

    // Opening a fresh temporary chat directly avoids aborting its initial load
    // with an immediate second navigation. Reused tabs navigate after loading.
    const pageDeadline = DateTime.toEpochMillis(DateTime.nowUnsafe()) + 30_000;
    let pageStatus = await invoke<PreviewAutomationStatus>("status", {});
    while (pageStatus.loading && DateTime.toEpochMillis(DateTime.nowUnsafe()) < pageDeadline) {
      signal.throwIfAborted();
      await NodeTimersPromises.setTimeout(500, undefined, { signal });
      pageStatus = await invoke<PreviewAutomationStatus>("status", {});
    }
    if (pageStatus.loading)
      throw new ChatGPTInteractionRequiredError(
        "ChatGPT is still loading in the visible T3 browser. Wait for the page, then retry; this did not start a cooldown.",
        false,
      );
    if (needsNavigation)
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
        readonly composerSelector?: string;
        readonly login: boolean;
        readonly challenge: boolean;
        readonly lockdownMessage: string;
        readonly retryButtonSelector?: string;
        readonly sendButtonSelector?: string;
        readonly composerHasText: boolean;
        readonly assistantCount: number;
        readonly userMessageCount: number;
        readonly answer: string;
        readonly answerTruncated: boolean;
        readonly generating: boolean;
      }>("evaluate", {
        expression: `(() => {
          const body = document.body?.innerText ?? "";
          const title = document.title ?? "";
          const visible = (element) => {
            const style = getComputedStyle(element);
            return element.getClientRects().length > 0 && style.display !== "none" && style.visibility !== "hidden";
          };
          const composerElement = [
            document.querySelector("#prompt-textarea"),
            document.querySelector('[contenteditable="true"][role="textbox"]'),
            document.querySelector("textarea"),
          ].find((element) => element && visible(element) && !element.disabled && !element.readOnly);
          const composer = !!composerElement;
          const composerText =
            composerElement instanceof HTMLTextAreaElement || composerElement instanceof HTMLInputElement
              ? composerElement.value
              : composerElement?.innerText ?? "";
          const composerSelector = composerElement?.id === "prompt-textarea"
            ? "#prompt-textarea"
            : composerElement?.matches('[contenteditable="true"][role="textbox"]')
              ? '[contenteditable="true"][role="textbox"]'
              : composerElement instanceof HTMLTextAreaElement
                ? "textarea"
                : undefined;
          const lockdownAlert = [
            ...document.querySelectorAll('[role="alert"], [role="status"], [data-sonner-toast]'),
          ].find(
            (element) => visible(element) && /couldn['’]t check lockdown mode/i.test(element.innerText),
          );
          const retryButton = [...(lockdownAlert?.querySelectorAll("button") ?? [])].find((button) =>
            visible(button) && button.innerText.trim() === "Retry",
          );
          const retryButtonSelector = (() => {
            if (!retryButton) return undefined;
            const path = [];
            for (let element = retryButton; element && element !== document.documentElement; ) {
              let part = element.localName;
              const parent = element.parentElement;
              if (!parent) break;
              const sameTag = [...parent.children].filter((child) => child.localName === element.localName);
              if (sameTag.length > 1)
                part += ":nth-of-type(" + (sameTag.indexOf(element) + 1) + ")";
              path.unshift(part);
              element = parent;
            }
            return path.join(" > ");
          })();
          const sendButton = [
            document.querySelector('[data-testid="send-button"]'),
            document.querySelector('button[aria-label="Send prompt"]'),
            document.querySelector('button[aria-label="Send message"]'),
            [...document.querySelectorAll("button")].find(
              (button) =>
                visible(button) &&
                !button.disabled &&
                /\b(send|submit)\b/i.test(button.getAttribute("aria-label") ?? ""),
            ),
          ].find((element) => element && visible(element) && !element.disabled);
          const sendButtonSelector = sendButton?.getAttribute("data-testid")
            ? 'button[data-testid="' + sendButton.getAttribute("data-testid") + '"]'
            : sendButton?.getAttribute("aria-label")
              ? 'button[aria-label="' + sendButton.getAttribute("aria-label") + '"]'
              : undefined;
          const login = [...document.querySelectorAll('[data-testid="login-button"], a[href*="/auth/login"]')].some(
            visible,
          );
          const challenge = /checking your browser|verify you are human|cloudflare|security check|just a moment|attention required|turnstile/i.test(
            title + " " + body.slice(0, 1200),
          );
          const markedAnswers = [...document.querySelectorAll('[data-message-author-role="assistant"]')].filter(
            visible,
          );
          // ChatGPT's current web UI removed its message-role attributes. These
          // visible group classes identify assistant output and user bubbles there.
          const answers =
            markedAnswers.length > 0
              ? markedAnswers
              : [...document.querySelectorAll("div.group.flex.min-w-0.flex-col")].filter(visible);
          const markedUserMessages = [
            ...document.querySelectorAll('[data-message-author-role="user"]'),
          ].filter(visible);
          const userMessages =
            markedUserMessages.length > 0
              ? markedUserMessages
              : [...document.querySelectorAll('[class~="group/user-message"]')].filter(visible);
          const last = answers.at(-1);
          const answerText = last?.innerText ?? "";
          // Preview automation caps serialized evaluation results at 64 KB.
          // Keep headroom for the rest of this observation and the protocol envelope.
          const answerLimit = 12_000;
          // ChatGPT can keep an inactive stop control mounted after a reply. Only
          // visible generation controls should keep the provider turn open.
          const generating = [
            ...document.querySelectorAll(
              '[data-testid="stop-button"], button[aria-label*="Stop generating" i], button[aria-label*="Stop response" i]',
            ),
          ].some(visible);
          return {
            composer,
            composerSelector,
            composerHasText: composerText.trim().length > 0,
            login,
            challenge,
            lockdownMessage: lockdownAlert?.innerText ?? "",
            retryButtonSelector,
            sendButtonSelector,
            assistantCount: answers.length,
            userMessageCount: userMessages.length,
            answer: answerText.slice(0, answerLimit),
            answerTruncated: answerText.length > answerLimit,
            generating,
          };
        })()`,
        awaitPromise: true,
        returnByValue: true,
      });

    let ready = await inspect();
    if (hasChatGPTLockdownCheckFailure(ready.lockdownMessage) && ready.retryButtonSelector) {
      try {
        // Resolve the moving toast's button at click time. Its entrance/exit
        // animation can put a previously measured point outside the viewport.
        await invoke("click", { selector: ready.retryButtonSelector });
      } catch {
        // Recheck below: the toast may have disappeared while the click ran.
      }
      const retryDeadline = DateTime.toEpochMillis(DateTime.nowUnsafe()) + 5_000;
      while (
        DateTime.toEpochMillis(DateTime.nowUnsafe()) < retryDeadline &&
        hasChatGPTLockdownCheckFailure(ready.lockdownMessage)
      ) {
        signal.throwIfAborted();
        await NodeTimersPromises.setTimeout(300, undefined, { signal });
        ready = await inspect();
      }
    }
    if (hasChatGPTLockdownCheckFailure(ready.lockdownMessage))
      throw new ChatGPTInteractionRequiredError(
        "ChatGPT couldn't check Lockdown Mode. Its Retry check is still failing, so T3 has not sent the prompt and did not start a cooldown. Restore the ChatGPT page connection, then retry this turn.",
        false,
      );
    const composerDeadline = DateTime.toEpochMillis(DateTime.nowUnsafe()) + 20_000;
    while (
      !ready.composer &&
      !ready.login &&
      !ready.challenge &&
      DateTime.toEpochMillis(DateTime.nowUnsafe()) < composerDeadline
    ) {
      signal.throwIfAborted();
      await NodeTimersPromises.setTimeout(500, undefined, { signal });
      ready = await inspect();
    }
    if (ready.challenge)
      throw new ChatGPTInteractionRequiredError(
        "ChatGPT requires verification. Complete it in the visible T3 browser; the request cooldown will apply.",
        true,
      );
    if (ready.login)
      throw new ChatGPTInteractionRequiredError(
        "Sign in to ChatGPT in the visible T3 browser, then retry this turn.",
        false,
      );
    if (!ready.composer)
      throw new ChatGPTInteractionRequiredError(
        "ChatGPT’s message box did not load in the visible T3 browser. Wait for ChatGPT to finish loading, then retry; this did not start a cooldown.",
        false,
      );

    if (!ready.composerSelector)
      throw new ChatGPTInteractionRequiredError(
        "ChatGPT’s message box is not available in the visible T3 browser. Sign in there, then retry this turn.",
        false,
      );
    try {
      await invoke("type", { selector: ready.composerSelector, text: prompt, clear: true });
    } catch {
      // ChatGPT can expose its ProseMirror textbox before the editor is ready to
      // accept input. Clear-and-replace makes one retry safe if the first call
      // inserted text but its acknowledgement was lost.
      signal.throwIfAborted();
      await NodeTimersPromises.setTimeout(500, undefined, { signal });
      const retryState = await inspect();
      if (retryState.challenge)
        throw new ChatGPTInteractionRequiredError(
          "ChatGPT requested verification. Complete it in the visible T3 browser, then retry this turn.",
          true,
        );
      if (!retryState.composer || !retryState.composerSelector)
        throw new ChatGPTInteractionRequiredError(
          "The ChatGPT message box disappeared before T3 could enter the prompt. Reload ChatGPT in the visible T3 browser, then retry; this did not start a cooldown.",
          false,
        );
      try {
        await invoke("type", {
          selector: retryState.composerSelector,
          text: prompt,
          clear: true,
        });
      } catch {
        throw new ChatGPTInteractionRequiredError(
          "T3 could not enter the prompt in ChatGPT’s visible message box. Click the message box in the T3 browser and retry; this did not start a cooldown.",
          false,
        );
      }
    }
    const before = ready.assistantCount;
    const beforeUserMessageCount = ready.userMessageCount;
    signal.throwIfAborted();
    const sendState = await inspect();
    if (hasChatGPTLockdownCheckFailure(sendState.lockdownMessage))
      throw new ChatGPTInteractionRequiredError(
        "ChatGPT couldn't check Lockdown Mode. T3 has not sent the prompt and did not start a cooldown. Restore the ChatGPT page connection, then retry this turn.",
        false,
      );
    if (!sendState.composerHasText)
      throw new ChatGPTInteractionRequiredError(
        "T3 entered no text in ChatGPT's message box, so it did not send the request or start a cooldown. Check the visible browser, then retry this turn.",
        false,
      );
    if (sendState.sendButtonSelector) {
      await invoke("click", { selector: sendState.sendButtonSelector, timeoutMs: 15_000 });
    } else {
      // Older ChatGPT layouts may not expose a labeled Send control.
      await invoke("press", { key: "Enter", timeoutMs: 15_000 });
    }
    const acceptedDeadline = DateTime.toEpochMillis(DateTime.nowUnsafe()) + 5_000;
    let accepted = false;
    while (DateTime.toEpochMillis(DateTime.nowUnsafe()) < acceptedDeadline) {
      signal.throwIfAborted();
      const submitted = await inspect();
      if (hasChatGPTLockdownCheckFailure(submitted.lockdownMessage))
        throw new ChatGPTInteractionRequiredError(
          "ChatGPT couldn't check Lockdown Mode. T3 did not receive confirmation that the prompt was sent, so no cooldown was started. Retry the page check and retry this turn.",
          false,
        );
      if (
        submitted.assistantCount > before ||
        isChatGPTPromptAccepted(submitted.userMessageCount, beforeUserMessageCount)
      ) {
        ready = submitted;
        accepted = true;
        break;
      }
      await NodeTimersPromises.setTimeout(250, undefined, { signal });
    }
    if (!accepted)
      throw new ChatGPTInteractionRequiredError(
        "ChatGPT left the prompt in its message box instead of sending it. T3 did not start a cooldown. Check the visible ChatGPT page, then retry this turn.",
        false,
      );
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
      if (isChatGPTReplyComplete(state, before)) {
        if (state.answerTruncated)
          throw new Error("ChatGPT's reply exceeded the 12,000-character limit T3 can inspect.");
        return state.answer.trim();
      }
    }
    throw new Error("ChatGPT did not finish a reply within three minutes.");
  }
}
