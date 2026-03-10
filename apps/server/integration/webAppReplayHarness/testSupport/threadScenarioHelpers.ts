import type { ReplayAppPage } from "./replayAppPage.ts";

export async function createReadyThread(app: ReplayAppPage): Promise<void> {
  await app.waitForBootstrap();
  await app.createThread();
}

export async function completeTurn(
  app: ReplayAppPage,
  prompt: string,
  expectedReply: string,
): Promise<void> {
  await app.sendMessage(prompt);
  await app.waitForTranscriptText(expectedReply);
}

export async function sendPromptInNewThread(
  app: ReplayAppPage,
  prompt: string,
  expectedReply: string,
): Promise<void> {
  await createReadyThread(app);
  await completeTurn(app, prompt, expectedReply);
}
