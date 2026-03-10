import type { Locator, Page } from "playwright";

const STEP_TIMEOUT_MS = 40_000;
const TEST_IDS = {
  branchToolbarBranchSelector: "branch-toolbar-branch-selector",
  branchToolbarEnvMode: "branch-toolbar-env-mode",
  chatComposerEditor: "chat-composer-editor",
  chatEmptyState: "chat-empty-state",
  chatOpenTurnDiff: "chat-open-turn-diff",
  chatProviderHealthBanner: "chat-provider-health-banner",
  chatSendButton: "chat-send-button",
  chatTurnDiffCard: "chat-turn-diff-card",
  chatTranscript: "chat-transcript",
  diffPanel: "diff-panel",
  sidebarCreateThreadButton: "sidebar-create-thread-button",
  sidebarProjectSection: "sidebar-project-section",
} as const;

export class ReplayAppPage {
  constructor(readonly page: Page) {}

  currentPath(): string {
    return new URL(this.page.url()).pathname;
  }

  async createThread(): Promise<void> {
    const bootstrapPath = this.currentPath();
    await this.createThreadButton.click();
    await this.page.waitForURL((url) => new URL(String(url)).pathname !== bootstrapPath, {
      timeout: STEP_TIMEOUT_MS,
    });
  }

  async goto(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
  }

  async openTurnDiff(): Promise<void> {
    await this.turnDiffCard.waitFor({
      state: "visible",
      timeout: STEP_TIMEOUT_MS,
    });
    await this.openTurnDiffButton.click();
  }

  async readComposerText(): Promise<string> {
    return (await this.composerEditor.textContent()) ?? "";
  }

  async readEnvMode(): Promise<string> {
    return (await this.envModeControl.textContent())?.trim() ?? "";
  }

  async readBranchSelectorLabel(): Promise<string> {
    return (await this.branchSelector.textContent())?.trim() ?? "";
  }

  async sendMessage(prompt: string): Promise<void> {
    await this.composerEditor.click();
    await this.page.keyboard.insertText(prompt);
    const deadline = Date.now() + STEP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await this.sendButton.isEnabled()) {
        await this.sendButton.click();
        return;
      }
      await this.page.waitForTimeout(100);
    }
    throw new Error(
      `Timed out waiting for the send button to enable. aria-label=${await this.sendButton.getAttribute("aria-label")} composer=${JSON.stringify(await this.readComposerText())}`,
    );
  }

  async switchToWorktreeMode(): Promise<void> {
    await this.envModeControl.click();
  }

  async typeIntoComposer(text: string): Promise<void> {
    await this.composerEditor.click();
    await this.page.keyboard.insertText(text);
  }

  async waitForBootstrap(): Promise<void> {
    await this.createThreadButton.waitFor({
      state: "visible",
      timeout: STEP_TIMEOUT_MS,
    });
    await this.emptyState.waitFor({
      state: "visible",
      timeout: STEP_TIMEOUT_MS,
    });
  }

  async waitForBranchSelectorText(text: string | RegExp): Promise<void> {
    await this.branchSelector.getByText(text).waitFor({
      state: "visible",
      timeout: STEP_TIMEOUT_MS,
    });
  }

  async waitForProviderUnavailable(message: string | RegExp): Promise<void> {
    await this.providerHealthBanner.waitFor({
      state: "visible",
      timeout: STEP_TIMEOUT_MS,
    });
    await this.providerHealthBanner.getByText(message).waitFor({
      state: "visible",
      timeout: STEP_TIMEOUT_MS,
    });
  }

  async waitForDiffPanel(): Promise<void> {
    await this.diffPanel.waitFor({
      state: "visible",
      timeout: STEP_TIMEOUT_MS,
    });
  }

  async waitForDiffText(text: string | RegExp): Promise<void> {
    await this.diffPanel.getByText(text).waitFor({
      state: "visible",
      timeout: STEP_TIMEOUT_MS,
    });
  }

  async waitForTurnDiffCardText(text: string | RegExp): Promise<void> {
    await this.turnDiffCard.getByText(text).waitFor({
      state: "visible",
      timeout: STEP_TIMEOUT_MS,
    });
  }

  async waitForTranscriptText(text: string | RegExp): Promise<void> {
    await this.transcript.getByText(text).waitFor({
      state: "visible",
      timeout: STEP_TIMEOUT_MS,
    });
  }

  private get branchSelector(): Locator {
    return this.page.getByTestId(TEST_IDS.branchToolbarBranchSelector);
  }

  private get composerEditor(): Locator {
    return this.page.getByTestId(TEST_IDS.chatComposerEditor);
  }

  private get createThreadButton(): Locator {
    return this.firstProjectSection.getByTestId(TEST_IDS.sidebarCreateThreadButton);
  }

  private get emptyState(): Locator {
    return this.page.getByTestId(TEST_IDS.chatEmptyState);
  }

  private get envModeControl(): Locator {
    return this.page.getByTestId(TEST_IDS.branchToolbarEnvMode);
  }

  private get diffPanel(): Locator {
    return this.page.getByTestId(TEST_IDS.diffPanel);
  }

  private get firstProjectSection(): Locator {
    return this.page.getByTestId(TEST_IDS.sidebarProjectSection).first();
  }

  private get openTurnDiffButton(): Locator {
    return this.page.getByTestId(TEST_IDS.chatOpenTurnDiff).first();
  }

  private get providerHealthBanner(): Locator {
    return this.page.getByTestId(TEST_IDS.chatProviderHealthBanner);
  }

  private get sendButton(): Locator {
    return this.page.getByTestId(TEST_IDS.chatSendButton);
  }

  private get transcript(): Locator {
    return this.page.getByTestId(TEST_IDS.chatTranscript);
  }

  private get turnDiffCard(): Locator {
    return this.page.getByTestId(TEST_IDS.chatTurnDiffCard).first();
  }
}
