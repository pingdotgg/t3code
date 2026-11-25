import { expect, it } from "vite-plus/test";
import { getJcodeModelRoute, groupJcodeModelRoutes } from "./providerSubProviders.js";

it("groups JCode routes by model within each instance while retaining exact route IDs", () => {
  const models = [
    { instanceId: "jcode", slug: "jcode-route:a", name: "gpt-5 (OpenAI, responses)" },
    { instanceId: "jcode", slug: "jcode-route:b", name: "gpt-5 (Gateway (EU), chat_completions)" },
    { instanceId: "jcode", slug: "jcode-route:c", name: "gpt-5-mini (OpenAI, responses)" },
    { instanceId: "other-jcode", slug: "jcode-route:a", name: "gpt-5 (OpenAI, responses)" },
    { instanceId: "codex", slug: "gpt-5", name: "gpt-5 (OpenAI, responses)" },
    { instanceId: "jcode", slug: "jcode-route:unknown", name: "Unrecognized route" },
  ];
  expect(groupJcodeModelRoutes(models, (model) => model)).toEqual([
    [models[0], models[1]],
    [models[2]],
    [models[3]],
    [models[4]],
    [models[5]],
  ]);
  expect(getJcodeModelRoute(models[1]!)).toEqual({
    name: "gpt-5",
    provider: "Gateway (EU)",
    apiMethod: "chat_completions",
  });
  expect(getJcodeModelRoute(models[4]!)).toBeNull();
  expect(getJcodeModelRoute(models[5]!)).toBeNull();
});
