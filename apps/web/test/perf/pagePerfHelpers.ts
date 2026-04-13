import type { Page } from "playwright";

import type { PerfAppHarness } from "./appHarness";

export async function ensureThreadRowVisible(
  page: Page,
  projectTitle: string,
  threadId: string,
): Promise<void> {
  const threadRow = page.getByTestId(`thread-row-${threadId}`);
  if (await threadRow.isVisible().catch(() => false)) {
    return;
  }

  const projectToggle = page.getByText(projectTitle, { exact: true }).first();
  await projectToggle.click();
  await threadRow.waitFor({ state: "visible", timeout: 20_000 });
}

export async function waitForThreadRoute(
  page: Page,
  input: {
    readonly threadId: string;
    readonly messageId?: string;
    readonly extraSelector?: string;
  },
): Promise<void> {
  const path = `/${encodeURIComponent(input.threadId)}`;
  const threadSelector = `[data-testid="chat-thread-${input.threadId}"]`;
  await page.waitForFunction(
    ({ expectedPath, threadSelector, messageSelector, extraSelector }) => {
      const pathMatches = window.location.pathname === expectedPath;
      if (!pathMatches) {
        return false;
      }
      if (!document.querySelector(threadSelector)) {
        return false;
      }

      if (messageSelector && !document.querySelector(messageSelector)) {
        return false;
      }
      if (extraSelector && !document.querySelector(extraSelector)) {
        return false;
      }
      return true;
    },
    {
      expectedPath: path,
      threadSelector,
      messageSelector: input.messageId ? `[data-message-id="${input.messageId}"]` : null,
      extraSelector: input.extraSelector ?? null,
    },
    { timeout: 45_000 },
  );
}

export async function measureThreadSwitch(
  harness: PerfAppHarness,
  input: {
    readonly actionName: string;
    readonly projectTitle: string;
    readonly threadId: string;
    readonly messageId?: string;
    readonly extraSelector?: string;
  },
): Promise<number | null> {
  await ensureThreadRowVisible(harness.page, input.projectTitle, input.threadId);
  await harness.startAction(input.actionName);
  await harness.page.getByTestId(`thread-row-${input.threadId}`).click();
  await waitForThreadRoute(harness.page, {
    threadId: input.threadId,
    ...(input.messageId ? { messageId: input.messageId } : {}),
    ...(input.extraSelector ? { extraSelector: input.extraSelector } : {}),
  });
  return await harness.endAction(input.actionName);
}

export async function scrollTimelineTo(page: Page, position: "top" | "bottom"): Promise<void> {
  await page.evaluate(async (targetPosition) => {
    const timelineRoot = document.querySelector<HTMLElement>('[data-timeline-root="true"]');
    const scrollContainer = timelineRoot?.parentElement;
    if (!scrollContainer) {
      throw new Error("Messages scroll container not found.");
    }

    scrollContainer.scrollTo({
      top: targetPosition === "bottom" ? scrollContainer.scrollHeight : 0,
      behavior: "auto",
    });

    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  }, position);
}

export async function typeIntoComposerAndSend(page: Page, message: string): Promise<void> {
  const editor = page.getByTestId("composer-editor");
  await editor.click();
  await page.keyboard.type(message);
  await page.getByRole("button", { name: "Send message" }).click();
}
