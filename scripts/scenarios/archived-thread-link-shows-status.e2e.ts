import { CommandId, ThreadId } from "@t3tools/contracts";
import { expect } from "e2e";
import * as Effect from "effect/Effect";

import { T3_HOME } from "../e2e.config.ts";
import { rpcClient, runPromise, test, WEB } from "./t3.ts";

test("A thread link shows its archive status", WEB, async ({ t3, app, screen, browser }) => {
  const project = await t3.project("demo");
  const target = await t3.thread({ project, title: "Earlier work", messages: ["Start"] });
  const thread = await t3.thread({
    project,
    title: "Review work",
    messages: ["Start"],
  });
  await t3.open(thread);

  const composer = screen.getByTestId("composer-editor");
  await composer.waitFor();
  await composer.pressSequentially("Review @Earlier");
  await screen.getByRole("option", "Earlier work", { exact: false }).tap();
  await browser.keyboard.press("Enter");

  const link = screen.getByRole("link", "Thread, Earlier work");
  await link.waitFor();
  const setArchived = (archived: boolean) =>
    runPromise(
      Effect.gen(function* () {
        const client = yield* rpcClient(T3_HOME, app.baseUrl ?? "");
        yield* client["orchestration.dispatchCommand"]({
          type: archived ? "thread.archive" : "thread.unarchive",
          commandId: CommandId.make(`scenario:archive-link:${target.threadId}:${archived}`),
          threadId: ThreadId.make(target.threadId),
        });
      }).pipe(Effect.scoped),
    );

  await setArchived(true);
  try {
    await expect(link).toHaveAttribute("aria-description", "Archived thread");
    await link.hover();
    await expect(screen.getByText("Archived thread", { exact: true })).toBeVisible();
  } finally {
    await app.screenshot("archived-thread-link");
  }
  await setArchived(false);
  await expect(link).not.toHaveAttribute("aria-description", "Archived thread");
});
