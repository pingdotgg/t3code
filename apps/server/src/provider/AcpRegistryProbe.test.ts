// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@t3tools/contracts";
import { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";

import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  acpRegistryProbeFailure,
  acpRegistryProbeResult,
  listAcpRegistrySessions,
  logoutAcpRegistry,
  normalizeAcpRegistryAuthMethods,
  normalizeAcpRegistryCommands,
} from "@t3tools/provider-acp-registry/testing";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import { readProviderReplayTranscript } from "@t3tools/provider-testing/replayTranscript";
import {
  CLINE_SECONDARY_MODEL_SELECTION,
  clineConfigOptionsAnsweredAt,
} from "../orchestration-v2/testkit/fixtures/acp_secondary_model/input.ts";

const instanceId = ProviderInstanceId.make("acpRegistry_codex");
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");
const decodeSettings = Schema.decodeSync(AcpRegistrySettings);

describe("ACP Registry probe", () => {
  it("returns advertised auth methods and de-duplicated models", () => {
    const result = acpRegistryProbeResult(instanceId, {
      sessionId: "probe-session",
      initializeResult: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          auth: { logout: {} },
          sessionCapabilities: { list: {}, resume: {} },
        },
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
    } satisfies AcpSessionRuntime.AcpSessionRuntimeStartResult);

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
      sessionManagement: {
        canList: true,
        canLoad: true,
        canResume: true,
        canLogout: true,
        canDelete: false,
        canConfigureProviders: false,
      },
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
    } satisfies AcpSessionRuntime.AcpSessionRuntimeStartResult);

    expect(result.models).toEqual([
      { id: "sonnet", name: "Sonnet", description: "Balanced" },
      { id: "haiku", name: "Haiku", description: null },
    ]);
    expect(result.currentModelId).toBe("sonnet");
  });

  // The replay fixture's answers follow Cline 3.0.70's `acpAgent.ts` source, not
  // a captured run: `provider` and then `model`, both `category: "model"`. Its
  // integrated run writes the selection checked here and prompts successfully.
  it.effect("lists Cline providers as models and its later model option as a session option", () =>
    Effect.gen(function* () {
      const transcript = yield* readProviderReplayTranscript(
        new URL(
          "../orchestration-v2/testkit/fixtures/acp_secondary_model/registry_transcript.ndjson",
          import.meta.url,
        ),
      );
      const configOptionsAnsweredAt = (label: string) =>
        clineConfigOptionsAnsweredAt(transcript, label);
      const discover = (configOptions: ReturnType<typeof configOptionsAnsweredAt>) =>
        acpRegistryProbeResult(instanceId, {
          sessionId: "cline-replay-session-1",
          initializeResult: { protocolVersion: 1 },
          sessionSetupResult: { sessionId: "cline-replay-session-1", configOptions },
          modelConfigId: "provider",
        });
      const probed = discover(configOptionsAnsweredAt("session.created"));

      expect(probed.models.map((model) => model.id)).toEqual([
        "cline",
        "cline-pass",
        "openai-codex",
      ]);
      expect(probed.currentModelId).toBe("cline");
      expect(probed.configOptions).toEqual([
        {
          id: "model",
          label: "Model",
          type: "select",
          selectsModel: true,
          options: [
            { id: "cline-free/step-5-preview", label: "Step 5 Preview (free)" },
            { id: "cline-free/mimo-v2.6-flash", label: "MiMo-V2.6-Flash (free)" },
            {
              id: "cline-free/muse-spark-1.3-contributor",
              label: "Muse Spark 1.3 Contributor (free)",
            },
          ],
          currentValue: "cline-free/step-5-preview",
        },
        {
          id: "mode",
          label: "Session Mode",
          description: "Controls whether the agent can modify files",
          type: "select",
          options: [
            {
              id: "plan",
              label: "Plan",
              description: "Explore the codebase and plan changes without modifying files",
            },
            { id: "act", label: "Act", description: "Make changes to the codebase" },
          ],
          currentValue: "act",
        },
        {
          id: "auto_approve",
          label: "Auto-approve tools",
          description: "Automatically approve all tool calls without asking for permission",
          type: "boolean",
          currentValue: false,
        },
      ]);

      // Picking ClinePass republishes the model option with its catalog.
      const switched = discover(configOptionsAnsweredAt("provider.applied"));
      expect(switched.models.map((model) => model.id)).toEqual(
        probed.models.map((model) => model.id),
      );
      expect(switched.currentModelId).toBe(CLINE_SECONDARY_MODEL_SELECTION.model);
      const [modelPick] = CLINE_SECONDARY_MODEL_SELECTION.options;
      const modelOption = switched.configOptions.find((option) => option.id === modelPick.id);
      expect(modelOption?.type === "select" ? modelOption.options : []).toContainEqual({
        id: modelPick.value,
        label: "Muse Spark 1.3 Contributor",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("lets only the first model select own the model picker", () => {
    const select = (id: string, values: ReadonlyArray<string>) =>
      ({
        id,
        name: id,
        category: "model",
        type: "select",
        currentValue: values[0] ?? "",
        options: values.map((value) => ({ value, name: value })),
      }) as const;
    const result = acpRegistryProbeResult(instanceId, {
      sessionId: "probe-session",
      initializeResult: { protocolVersion: 1 },
      sessionSetupResult: {
        sessionId: "probe-session",
        configOptions: [
          { id: "fast", name: "Fast", category: "model", type: "boolean", currentValue: false },
          select("provider", ["gateway", "local"]),
          select("model", ["opus", "haiku"]),
          // A repeated ID would write over the picked model.
          select("provider", ["other"]),
        ],
      },
      modelConfigId: "provider",
    } satisfies AcpSessionRuntime.AcpSessionRuntimeStartResult);

    expect(result.models.map((model) => model.id)).toEqual(["gateway", "local"]);
    expect(result.currentModelId).toBe("gateway");
    expect(result.configOptions.map((option) => option.id)).toEqual(["fast", "model"]);
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
    } satisfies AcpSessionRuntime.AcpSessionRuntimeStartResult);

    expect(result.models).toEqual([{ id: "valid", name: "Valid", description: null }]);
    expect(result.currentModelId).toBeNull();
  });

  it("preserves grouped model values and advertises reasoning choices", () => {
    const codexModel = '["codex","gpt-6.1-sol"]';
    const goModel = '["opencode-go","deepseek-v4.1-flash"]';
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
            currentValue: goModel,
            options: [
              {
                groupId: "codex",
                name: "Codex",
                options: [{ value: codexModel, name: "GPT-6.1 Sol" }],
              },
              {
                groupId: "opencode-go",
                name: "OpenCode Go",
                options: [{ value: goModel, name: "DeepSeek V4.1 Flash" }],
              },
            ],
          },
          {
            id: "reasoning",
            name: "Reasoning",
            category: "thought_level",
            type: "select",
            currentValue: "high",
            options: [
              {
                groupId: "effort",
                name: "Effort",
                options: [
                  { value: "medium", name: "Medium" },
                  { value: "high", name: "High" },
                ],
              },
            ],
          },
        ],
      },
      modelConfigId: "model",
    } satisfies AcpSessionRuntime.AcpSessionRuntimeStartResult);

    expect(result.models).toEqual([
      { id: codexModel, name: "GPT-6.1 Sol", description: null },
      { id: goModel, name: "DeepSeek V4.1 Flash", description: null },
    ]);
    expect(result.currentModelId).toBe(goModel);
    expect(result.configOptions).toEqual([
      {
        id: "reasoning",
        label: "Reasoning",
        type: "select",
        currentValue: "high",
        options: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
        ],
      },
    ]);
  });

  it.each(["config option", "session model state"] as const)(
    "retains the current model beyond the catalog cap from %s",
    (source) => {
      const models = Array.from({ length: 257 }, (_, index) => ({
        modelId: `model-${index}`,
        name: `Model ${index}`,
      }));
      const result = acpRegistryProbeResult(instanceId, {
        sessionId: "probe-session",
        initializeResult: { protocolVersion: 1 },
        sessionSetupResult: {
          sessionId: "probe-session",
          ...(source === "config option"
            ? {
                configOptions: [
                  {
                    id: "model",
                    name: "Model",
                    category: "model",
                    type: "select",
                    currentValue: "model-256",
                    options: models.map(({ modelId, name }) => ({ value: modelId, name })),
                  },
                ],
              }
            : { models: { currentModelId: "model-256", availableModels: models } }),
        },
        modelConfigId: source === "config option" ? "model" : undefined,
      } satisfies AcpSessionRuntime.AcpSessionRuntimeStartResult);

      expect(result.models).toHaveLength(256);
      expect(result.models[0]?.id).toBe("model-0");
      expect(result.models.at(-1)?.id).toBe("model-256");
      expect(result.currentModelId).toBe("model-256");
    },
  );

  it("bounds and de-duplicates advertised commands", () => {
    const commands = normalizeAcpRegistryCommands([
      {
        name: "create_plan",
        description: " Create a plan ",
        input: { type: "text", hint: " topic " },
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

  it.effect("lists native sessions and logs out through generic ACP lifecycle methods", () => {
    const catalog = AcpRegistrySupport.AcpRegistryCatalog.of({
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
            description: "ACP session management test agent",
            distribution: { npx: { package: "mock-agent@1.0.0" } },
          },
          distribution: "npx" as const,
          spawn: {
            command: "node",
            args: [mockAgentPath],
            env: {
              ...process.env,
              T3_ACP_SESSION_LIFECYCLE: "1",
              T3_ACP_AUTH_METHOD_ID: "mock-login",
            },
          },
        }),
    });
    const input = {
      instanceId,
      settings: decodeSettings({ agentId: "mock-agent" }),
      cwd: process.cwd(),
      environment: process.env,
    };

    return Effect.gen(function* () {
      const listed = yield* listAcpRegistrySessions(input);
      expect(listed).toMatchObject({
        canLoad: true,
        canResume: true,
        nextCursor: null,
        sessions: [
          {
            sessionId: "mock-session-1",
            cwd: process.cwd(),
            importedThreadId: null,
          },
        ],
      });
      yield* logoutAcpRegistry(input);
    }).pipe(
      Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    );
  });

  it("distinguishes authentication failures from generic probe failures", () => {
    const advertised = normalizeAcpRegistryAuthMethods([
      { id: "grok-login", name: "Log in with Grok" },
    ]);
    const cause = new EffectAcpErrors.AcpRequestError({
      code: -32000,
      errorMessage: "login required",
    });
    const authFailure = acpRegistryProbeFailure(cause, advertised);
    expect(authFailure.reason).toBe("authentication_failed");
    expect(authFailure.message).toBe("The ACP agent could not complete authentication.");
    expect(authFailure.cause).toBe(cause);
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
          detail: "Authentication required",
          cause: "credentials missing",
        }),
      ).reason,
    ).toBe("authentication_failed");
    const genericCause = new EffectAcpErrors.AcpTransportError({
      detail: "connection closed",
      cause: "closed",
    });
    const genericFailure = acpRegistryProbeFailure(genericCause);
    expect(genericFailure.reason).toBe("probe_failed");
    expect(genericFailure.message).toBe("The ACP agent could not create a test session.");
    expect(genericFailure.cause).toBe(genericCause);
    expect(
      acpRegistryProbeFailure(
        new EffectAcpErrors.AcpTransportError({
          detail: "Failed while logging request",
          cause: "logging failed",
        }),
      ).reason,
    ).toBe("probe_failed");
  });
});
