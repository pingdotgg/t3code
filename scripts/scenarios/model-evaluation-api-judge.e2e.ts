import { expect } from "e2e";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The fixture owns a disposable HTTP listener.
import * as NodeHttp from "node:http";

import { test, WEB } from "./t3.ts";

test(
  "A connected model API can be selected as the evaluation judge",
  WEB,
  async ({ t3, app, screen }) => {
    const judged = Promise.withResolvers<string>();
    await using api = NodeHttp.createServer(async (request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/v1/models") {
        response.end(JSON.stringify({ data: [{ id: "judge-fixture-model", object: "model" }] }));
        return;
      }
      if (request.url === "/v1/chat/completions") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString("utf8");
        response.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: JSON.stringify({
                    outcome: "insufficient_evidence",
                    taskCategory: "other",
                    confidence: "low",
                    scores: {
                      taskCompletion: null,
                      correctness: null,
                      instructionFollowing: null,
                      verification: null,
                    },
                    rationale: {
                      text: "The fixture judge received the task evidence.",
                      citations: ["U1"],
                    },
                    strengths: [],
                    weaknesses: [],
                    promptAdvice: [],
                  }),
                },
              },
            ],
          }),
        );
        judged.resolve(body);
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve, reject) => {
      api.once("error", reject);
      api.listen(0, "127.0.0.1", resolve);
    });
    const address = api.address();
    if (address === null || typeof address === "string") throw new Error("No model API port.");

    const workspace = await t3.project("judge-fixture");
    await t3.open();
    await expect(screen.getByRole("button", "New thread", { exact: true })).toBeVisible();
    await app.open("/settings/providers");
    await screen.getByRole("button", "Add generator").tap();
    await screen.getByRole("radio", "Custom").tap();
    await screen.getByRole("textbox", "Base URL").fill(`http://127.0.0.1:${address.port}/v1`);
    await screen.getByRole("textbox", "Name (optional)").fill("Scenario API");
    await screen.getByRole("button", "Connect", { exact: true }).tap();
    await screen.getByRole("button", "Done", { exact: true }).tap();

    await app.open("/settings/labs");
    const judge = screen.getByRole("button", "Judge model", { exact: true });
    await expect(judge).toBeEnabled();
    await app.screenshot("judge-api-selection");
    await judge.tap();
    const apiProvider = screen.getByRole("button", "Scenario API", { exact: true });
    await expect(apiProvider).toBeVisible();
    await apiProvider.tap();
    await screen.getByRole("option", "judge-fixture-model", { exact: false }).tap();
    await expect(judge).toHaveText(/judge-fixture-model$/);
    const enabled = screen.getByRole("switch", "Blind model evaluations");
    await expect(enabled).toBeEnabled();
    await enabled.tap();
    await expect(enabled).toBeChecked();

    await t3.thread({
      project: workspace,
      title: "Evaluated task",
      messages: ["Explain the project."],
      model: "multi-turn",
    });
    expect(JSON.parse(await judged.promise).model).toBe("judge-fixture-model");

    await app.open("/settings/labs");
    await expect(judge).toHaveText(/judge-fixture-model$/);
    await expect(enabled).toBeChecked();
    await app.screenshot("judge-api-saved");
    await screen.getByRole("combobox", "Evaluation project on", { exact: false }).tap();
    await screen.getByRole("option", "judge-fixture", { exact: true }).tap();
    await screen.getByText("Recent evaluations (1)", { exact: true }).tap();
    await expect(
      screen.getByText("The fixture judge received the task evidence.", { exact: true }),
    ).toBeVisible();
    await app.screenshot("judge-api-evaluation");
    await screen.getByRole("button", "Use default", { exact: true }).tap();
    await expect(judge).toHaveText(/gpt-6-luna$/);
  },
);
