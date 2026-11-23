import { ProjectSnapshot, ProviderInstanceId } from "@t3tools/contracts";
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { T3_HOME } from "../e2e.config.ts";
import { makeState, rpcClient, runPromise, test, WEB } from "./t3.ts";

const PROMPT_LOG_LIMIT = 64 * 1024;
const FRAME_OPEN = "<webhook-data-000000000000>".length;

const deliverStraddlingEmoji = Effect.fn("scenario.deliverStraddlingEmoji")(
  function* (origin: string) {
    const issued = yield* makeState(T3_HOME).cli(["auth", "session", "issue", "--token-only"]);
    const { projects } = yield* HttpClient.execute(
      HttpClientRequest.get(`${origin}/api/projects`).pipe(
        HttpClientRequest.bearerToken(issued.stdout.trim()),
      ),
    ).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(ProjectSnapshot)),
    );
    const client = yield* rpcClient(T3_HOME, origin);
    const { task } = yield* client["scheduledTasks.upsert"]({
      title: "Webhook log",
      prompt: "{{body.text}}",
      enabled: true,
      schedule: { type: "webhook" },
      projectId: projects.find((project) => project.title === "webhook-log")!.id,
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: ProviderInstanceId.make("devReplay"), model: "showcase" },
      runtimeMode: "full-access",
      interactionMode: "default",
    });
    // The emoji's high surrogate is the last code unit the delivery log keeps.
    const text = `${"a".repeat(PROMPT_LOG_LIMIT - 1 - FRAME_OPEN)}😀 tail`;
    yield* HttpClient.execute(
      HttpClientRequest.post(`${origin}${task.webhook!.path}`).pipe(
        HttpClientRequest.bodyJsonUnsafe({ text }),
      ),
    ).pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
  },
  Effect.scoped,
  Effect.provide(FetchHttpClient.layer),
);

test(
  "A long webhook prompt in the delivery log does not end in a broken character",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await t3.project("webhook-log");
    await runPromise(deliverStraddlingEmoji(app.baseUrl ?? ""));

    await t3.open("/settings/scheduled-tasks");
    await screen.getByRole("button", "Actions for Webhook log").tap();
    await screen.getByRole("menuitem", "Deliveries").tap();
    const dialog = screen.getByRole("dialog");
    await dialog.getByRole("button", /POST/).tap();
    const prompt = dialog.getByText(/^<webhook-data-/);
    await prompt.waitFor();
    await browser.evaluate(() => {
      const block = [...document.querySelectorAll("pre")].find((pre) =>
        pre.textContent?.startsWith("<webhook-data-"),
      );
      block?.scrollIntoView({ block: "center" });
      if (block) block.scrollTop = block.scrollHeight;
      return null;
    });
    try {
      await expect(prompt).not.toContainText("�");
    } finally {
      await app.screenshot("logged-prompt-end");
    }
  },
);
