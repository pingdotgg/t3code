import { describe, expect, it } from "vite-plus/test";
import type { ProviderCloudConfiguration } from "@t3tools/contracts";
import { codexCloudMessage } from "./CodexCloudConversation.ts";
const config: ProviderCloudConfiguration = {
  id: "asenvcfg_test",
  name: "T3 Code",
  status: "draft",
  versionId: "version-1",
  published: false,
  threadId: null,
  draftId: null,
  revision: null,
  repositories: [],
  installScript: "",
  startSkill: "",
  cwd: "/workspace",
};
const transform = (
  method: string,
  params: unknown,
  changes: Partial<ProviderCloudConfiguration> = {},
) =>
  JSON.parse(
    codexCloudMessage(JSON.stringify({ id: 1, method, params }), { ...config, ...changes }),
  );
describe("Codex Cloud conversation boundary", () => {
  it("starts onboarding with the saved configuration and no local filesystem or MCP configuration", () => {
    expect(
      transform("thread/start", {
        model: "gpt-6.1",
        cwd: "/private/local",
        config: { mcp_servers: { local: {} } },
      }),
    ).toEqual({
      id: 1,
      method: "thread/start",
      params: {
        model: "gpt-6.1",
        serviceName: "codex_cloud",
        deferredEnvironment: true,
        pluginsMcp: { productSku: "codex" },
        environments: [{ onboardingConfigId: config.id }],
      },
    });
  });
  it("resumes the existing setup conversation rather than creating another VM", () => {
    expect(transform("thread/start", {}, { threadId: "existing-setup" })).toEqual({
      id: 1,
      method: "thread/resume",
      params: { threadId: "existing-setup", excludeTurns: false },
    });
  });
  it("starts ordinary tasks from published configurations", () => {
    expect(
      transform("thread/start", {}, { published: true, threadId: "setup" }).params.environments,
    ).toEqual([{ environmentConfigId: config.id }]);
  });
  it("keeps turn input and removes machine-specific permissions and paths", () => {
    expect(
      transform("turn/start", {
        threadId: "thread-1",
        input: [{ type: "text", text: "Set up" }],
        cwd: "/private/local",
        sandboxPolicy: { type: "workspaceWrite" },
        approvalPolicy: "never",
        config: {},
      }).params,
    ).toEqual({
      threadId: "thread-1",
      input: [{ type: "text", text: "Set up" }],
      turnTrigger: "environment_onboarding",
    });
  });
});
