// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { AcpRegistrySettings, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";

import type { AcpSessionRuntimeStartResult } from "./AcpSessionRuntime.ts";
import {
  acpRegistryProbeFailure,
  acpRegistryProbeResult,
  normalizeAcpRegistryAuthMethods,
  normalizeAcpRegistryCommands,
  probeAcpRegistryConfiguration,
} from "./AcpRegistryProbe.ts";
import { AcpRegistryCatalog } from "./AcpRegistrySupport.ts";

const instanceId = ProviderInstanceId.make("acpRegistry_codex");
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const decodeSettings = Schema.decodeSync(AcpRegistrySettings);

describe("ACP Registry probe", () => {
  it("returns advertised auth methods and de-duplicated models", () => {
    const result = acpRegistryProbeResult(instanceId, {
      sessionId: "probe-session",
      initializeResult: {
        protocolVersion: 1,
        authMethods: [
          { id: "chatgpt", name: "ChatGPT" },
          {
            id: "api-key",
            name: "API key",
            type: "env_var",
            vars: [{ name: "OPENAI_API_KEY", label: "OpenAI API key" }],
          },
          { id: "login", name: "Terminal login", type: "terminal" },
        ],
      },
      sessionSetupResult: {
        sessionId: "probe-session",
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "gpt-5.4",
            options: [
              { value: "gpt-5.4", name: "GPT-5.4" },
              { value: "gpt-5.4", name: "Duplicate" },
            ],
          },
        ],
      },
      modelConfigId: "model",
    } satisfies AcpSessionRuntimeStartResult);

    expect(result).toEqual({
      instanceId,
      ready: true,
      icon: null,
      authMethods: [
        { id: "chatgpt", name: "ChatGPT", description: null, type: "agent" },
        {
          id: "api-key",
          name: "API key",
          description: null,
          type: "env_var",
          envVarNames: ["OPENAI_API_KEY"],
        },
        { id: "login", name: "Terminal login", description: null, type: "terminal" },
      ],
      models: [{ id: "gpt-5.4", name: "GPT-5.4", description: null }],
      currentModelId: "gpt-5.4",
      configOptions: [],
    });
  });

  it("composes runnable terminal auth commands from the resolved spawn recipe", () => {
    const methods = normalizeAcpRegistryAuthMethods(
      [
        {
          id: "login",
          name: "Terminal login",
          type: "terminal",
          args: ["auth", "log in"],
          env: { FORCE_TTY: "1" },
        },
      ],
      { command: "/opt/agents/devin", args: ["--acp"] },
    );

    expect(methods).toEqual([
      {
        id: "login",
        name: "Terminal login",
        description: null,
        type: "terminal",
        command: "FORCE_TTY=1 /opt/agents/devin --acp auth 'log in'",
      },
    ]);
  });

  it("omits unsafe truncated auth commands instead of publishing broken shell", () => {
    const methods = normalizeAcpRegistryAuthMethods(
      [
        {
          id: "login",
          name: "Terminal login",
          type: "terminal",
          args: ["x".repeat(2_048)],
        },
      ],
      { command: "/opt/agents/devin", args: ["--acp"] },
    );

    expect(methods[0]).not.toHaveProperty("command");
  });

  it("omits overlong opaque auth method and environment variable ids", () => {
    const methods = normalizeAcpRegistryAuthMethods([
      { id: "x".repeat(129), name: "Invalid" },
      {
        id: "api-key",
        name: "API key",
        type: "env_var",
        vars: [
          { name: "y".repeat(129), label: "Invalid" },
          { name: "OPENAI_API_KEY", label: "OpenAI API key" },
        ],
      },
    ]);

    expect(methods).toEqual([
      {
        id: "api-key",
        name: "API key",
        description: null,
        type: "env_var",
        envVarNames: ["OPENAI_API_KEY"],
      },
    ]);
  });

  it("falls back to model-category configuration options", () => {
    const result = acpRegistryProbeResult(instanceId, {
      sessionId: "probe-session",
      initializeResult: { protocolVersion: 1 },
      sessionSetupResult: {
        sessionId: "probe-session",
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "sonnet",
            options: [
              { value: "sonnet", name: "Sonnet", description: "Balanced" },
              { value: "haiku", name: "Haiku" },
            ],
          },
        ],
      },
      modelConfigId: "model",
    } satisfies AcpSessionRuntimeStartResult);

    expect(result.models).toEqual([
      { id: "sonnet", name: "Sonnet", description: "Balanced" },
      { id: "haiku", name: "Haiku", description: null },
    ]);
    expect(result.currentModelId).toBe("sonnet");
  });

  it("omits overlong opaque model ids instead of publishing mutated ids", () => {
    const result = acpRegistryProbeResult(instanceId, {
      sessionId: "probe-session",
      initializeResult: { protocolVersion: 1 },
      sessionSetupResult: {
        sessionId: "probe-session",
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "x".repeat(129),
            options: [
              { value: "x".repeat(129), name: "Too long" },
              { value: "valid", name: "Valid" },
            ],
          },
        ],
      },
      modelConfigId: "model",
    } satisfies AcpSessionRuntimeStartResult);

    expect(result.models).toEqual([{ id: "valid", name: "Valid", description: null }]);
    expect(result.currentModelId).toBeNull();
  });

  it("omits a current model that falls outside the bounded model catalog", () => {
    const result = acpRegistryProbeResult(instanceId, {
      sessionId: "probe-session",
      initializeResult: { protocolVersion: 1 },
      sessionSetupResult: {
        sessionId: "probe-session",
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "model-256",
            options: Array.from({ length: 257 }, (_, index) => ({
              value: `model-${index}`,
              name: `Model ${index}`,
            })),
          },
        ],
      },
      modelConfigId: "model",
    } satisfies AcpSessionRuntimeStartResult);

    expect(result.models).toHaveLength(256);
    expect(result.currentModelId).toBeNull();
  });

  it("bounds and de-duplicates advertised commands", () => {
    const commands = normalizeAcpRegistryCommands([
      {
        name: "create_plan",
        description: " Create a plan ",
        input: { hint: " topic " },
      },
      { name: "CREATE_PLAN", description: "duplicate" },
      ...Array.from({ length: 140 }, (_, index) => ({
        name: `command_${index}`,
        description: "",
      })),
    ]);

    expect(commands.slashCommands).toHaveLength(128);
    expect(commands.slashCommands[0]).toEqual({
      name: "create_plan",
      description: "Create a plan",
      input: { hint: "topic" },
    });
    expect(
      commands.slashCommands.filter((command) => command.name.toLowerCase() === "create_plan"),
    ).toHaveLength(1);
    expect(commands.skills).toEqual([]);
  });

  it("routes dollar-prefixed ACP commands to the provider skill menu", () => {
    expect(
      normalizeAcpRegistryCommands([
        { name: "$workspace-skill", description: "Run the workspace skill" },
        { name: "$WORKSPACE-SKILL", description: "duplicate" },
        { name: "$", description: "empty" },
        { name: "review", description: "Review changes" },
      ]),
    ).toEqual({
      slashCommands: [{ name: "review", description: "Review changes" }],
      skills: [
        {
          name: "workspace-skill",
          description: "Run the workspace skill",
          path: "acp://skill/workspace-skill",
          scope: "agent",
          enabled: true,
        },
      ],
    });
  });

  it.effect("captures commands advertised just after session creation", () =>
    Effect.gen(function* () {
      const result = yield* probeAcpRegistryConfiguration({
        instanceId,
        settings: decodeSettings({ agentId: "mock-agent" }),
        cwd: process.cwd(),
        environment: process.env,
      });

      expect(result.slashCommands).toEqual([
        {
          name: "review",
          description: "Review the current changes",
          input: { hint: "focus" },
        },
      ]);
      expect(result.skills).toEqual([
        {
          name: "workspace-skill",
          description: "Run the workspace skill",
          path: "acp://skill/workspace-skill",
          scope: "agent",
          enabled: true,
        },
      ]);
    }).pipe(
      Effect.provideService(
        AcpRegistryCatalog,
        AcpRegistryCatalog.of({
          search: () => Effect.die("unused search"),
          prepare: () => Effect.die("unused prepare"),
          inspect: () => Effect.die("unused inspect"),
          uninstallManagedBinary: () => Effect.die("unused uninstall"),
          resolve: () =>
            Effect.succeed({
              agent: {
                id: "mock-agent",
                name: "Mock Agent",
                version: "1.0.0",
                description: "ACP probe test agent",
                distribution: { npx: { package: "mock-agent@1.0.0" } },
              },
              distribution: "npx",
              spawn: {
                command: "node",
                args: [mockAgentPath],
                env: {
                  ...process.env,
                  T3_ACP_COMMAND_ADVERTISEMENT_DELAY_MS: "25",
                },
              },
            }),
        }),
      ),
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  );

  it("distinguishes authentication failures from generic probe failures", () => {
    const advertised = normalizeAcpRegistryAuthMethods([
      { id: "grok-login", name: "Log in with Grok" },
    ]);
    const authFailure = acpRegistryProbeFailure(
      new EffectAcpErrors.AcpRequestError({
        code: -32000,
        errorMessage: "login required",
      }),
      advertised,
    );
    expect(authFailure.reason).toBe("authentication_failed");
    expect(authFailure.authMethods).toEqual([
      {
        id: "grok-login",
        name: "Log in with Grok",
        description: null,
        type: "agent",
      },
    ]);
    expect(
      acpRegistryProbeFailure(
        new EffectAcpErrors.AcpTransportError({
          detail: "connection closed",
          cause: "closed",
        }),
      ).reason,
    ).toBe("probe_failed");
  });
});
