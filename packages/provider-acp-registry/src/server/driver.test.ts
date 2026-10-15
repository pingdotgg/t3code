import {
  AcpRegistryOperationError,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ServerProvider,
} from "@t3tools/contracts";
import { AcpRegistrySettings } from "../settings.ts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as AcpRegistryRuntimeCoordinator from "./AcpRegistryRuntimeCoordinator.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import { recordAcpRegistryModelOptions, type AcpRegistryLiveConfiguration } from "./probe.ts";
import {
  acpRegistrySnapshotReadiness,
  applyAcpRegistryAvailableCommands,
  applyAcpRegistryLiveConfiguration,
  applyAcpRegistryModelOptions,
  buildCheckedAcpRegistrySnapshot,
  checkAcpRegistryProviderReadiness,
  checkAcpRegistryProviderStatus,
} from "./driver.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
const identity = {
  instanceId: ProviderInstanceId.make("acpRegistry_test"),
  displayName: "Test ACP",
  accentColor: undefined,
  continuationKey: "acpRegistry:instance:acpRegistry_test",
};
const noSessionManagement = {
  canList: false,
  canLoad: false,
  canResume: false,
  canLogout: false,
  canDelete: false,
  canConfigureProviders: false,
} as const;

const WIDE_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const NARROW_LEVELS = ["low", "high", "max"];
const thinking = (levels: ReadonlyArray<string>, currentValue: string) => ({
  id: "thought_level",
  label: "Thinking",
  type: "select" as const,
  options: levels.map((id) => ({ id, label: id })),
  currentValue,
});
const wideThinking = thinking(WIDE_LEVELS, "medium");
const narrowThinking = thinking(NARROW_LEVELS, "high");
const models = [
  { id: "opus", name: "Opus", description: null },
  { id: "glm", name: "GLM", description: null },
];

function probedSnapshot(
  currentModelId: string | null,
  configOptions: ReadonlyArray<ProviderOptionDescriptor>,
  settings: { readonly customModels?: ReadonlyArray<string> } = {},
): ServerProvider {
  return buildCheckedAcpRegistrySnapshot({
    ...identity,
    settings: decodeSettings({ agentId: "devin", ...settings }),
    checkedAt: "2026-10-03T10:00:00.000Z",
    inspection: { status: "ready", agentId: "devin", version: "1.0.0", distribution: "binary" },
    probe: {
      probe: {
        instanceId: identity.instanceId,
        ready: true,
        icon: null,
        authMethods: [],
        models,
        currentModelId,
        configOptions,
        sessionManagement: noSessionManagement,
      },
      slashCommands: [],
      skills: [],
    },
  });
}

/** Thinking-level choice ids each model offers in the composer. */
function thinkingChoices(provider: ServerProvider): Record<string, ReadonlyArray<string>> {
  return Object.fromEntries(
    provider.models.map((model) => [
      model.slug,
      (model.capabilities?.optionDescriptors ?? []).flatMap((descriptor) =>
        descriptor.id === "thought_level" && descriptor.type === "select"
          ? descriptor.options.map((choice) => choice.id)
          : [],
      ),
    ]),
  );
}

function thinkingCurrentValue(provider: ServerProvider, slug: string) {
  const descriptor = provider.models
    .find((model) => model.slug === slug)
    ?.capabilities?.optionDescriptors?.find((candidate) => candidate.id === "thought_level");
  return descriptor?.type === "select" ? descriptor.currentValue : undefined;
}

/** The coordinator state after one live session reports `latest`. */
function liveState(
  latest: AcpRegistryLiveConfiguration,
): AcpRegistryRuntimeCoordinator.AcpRegistryLiveConfigurationState {
  return { latest, modelOptions: recordAcpRegistryModelOptions(new Map(), latest) };
}

function catalogWithInspection(
  inspection: AcpRegistrySupport.AcpRegistryInspection,
): AcpRegistrySupport.AcpRegistryCatalog["Service"] {
  return {
    search: () => Effect.die("unused search"),
    prepare: () => Effect.die("unused prepare"),
    inspect: () => Effect.succeed(inspection),
    resolve: () => Effect.die("unused resolve"),
    uninstallManagedBinary: () => Effect.die("unused uninstall"),
  };
}

describe("acpRegistrySnapshotReadiness", () => {
  it("treats a live empty command advertisement as an authoritative replacement", () => {
    const provider = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "test-agent" }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "npx",
        documentationUrl: "https://example.test/agent/setup",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models: [],
          currentModelId: null,
          configOptions: [],
          sessionManagement: noSessionManagement,
        },
        slashCommands: [{ name: "stale" }],
        skills: [{ name: "stale-skill", path: "stale", enabled: true }],
      },
    });

    const replaced = applyAcpRegistryAvailableCommands(
      provider,
      Option.some({ slashCommands: [], skills: [] }),
    );
    expect(replaced.slashCommands).toEqual([]);
    expect(replaced.skills).toEqual([]);
    expect(applyAcpRegistryAvailableCommands(provider, Option.none()).slashCommands).toEqual([
      { name: "stale" },
    ]);
    expect(provider.iconUrl).toBe(
      "https://cdn.agentclientprotocol.com/registry/v1/latest/test-agent.svg",
    );
    expect(provider.setup).toMatchObject({
      canAuthenticate: false,
      documentationUrl: "https://example.test/agent/setup",
    });
  });

  it("keeps authentication unknown when an agent permits a discovery session before sign-in", () => {
    const snapshot = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "test-agent" }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "binary",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [{ id: "browser", name: "Browser", description: null, type: "agent" }],
          models: [],
          currentModelId: null,
          configOptions: [],
          sessionManagement: noSessionManagement,
        },
        slashCommands: [],
        skills: [],
      },
    });
    expect(snapshot.auth.status).toBe("unknown");
    expect(snapshot.setup?.canAuthenticate).toBe(true);
    expect(
      applyAcpRegistryLiveConfiguration(
        snapshot,
        liveState({ models: [], currentModelId: null, configOptions: [] }),
        [],
      ).auth.status,
    ).toBe("unknown");
  });

  it("overlays live configuration without dropping probe-owned session capabilities", () => {
    const provider = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "test-agent" }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "npx",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models: [{ id: "probe-model", name: "Probe model", description: null }],
          currentModelId: "probe-model",
          configOptions: [],
          sessionManagement: {
            canList: true,
            canLoad: true,
            canResume: true,
            canLogout: true,
            canDelete: true,
            canConfigureProviders: true,
          },
        },
        slashCommands: [],
        skills: [],
      },
    });

    expect(
      applyAcpRegistryLiveConfiguration(
        provider,
        liveState({
          models: [{ id: "live-model", name: "Live model", description: null }],
          currentModelId: "live-model",
          configOptions: [],
        }),
        [],
      ),
    ).toMatchObject({
      auth: { status: "unknown", canLogout: true },
      nativeSessions: { canList: true, canLoad: true, canResume: true },
      models: [{ slug: "live-model", isDefault: true }],
    });
  });

  it("describes discovered session options only on the model they belong to", () => {
    const snapshot = probedSnapshot("opus", [wideThinking], { customModels: ["custom-model"] });
    expect(thinkingChoices(snapshot)).toEqual({
      opus: WIDE_LEVELS,
      glm: [],
      "custom-model": [],
    });

    // A session whose current model is not one the agent lists describes no model.
    expect(thinkingChoices(probedSnapshot(null, [wideThinking]))).toEqual({ opus: [], glm: [] });
  });

  it.effect("keeps each model's last observed options across live sessions and refreshes", () =>
    Effect.gen(function* () {
      const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
      const otherInstance = ProviderInstanceId.make("acpRegistry_other");
      const liveConfiguration = () =>
        coordinator.getLiveConfiguration(identity.instanceId).pipe(Effect.map(Option.getOrThrow));

      // A thread runs on Opus with Extra High selected, then another on GLM.
      yield* coordinator.publishLiveConfiguration(identity.instanceId, {
        models,
        currentModelId: "opus",
        configOptions: [{ ...wideThinking, currentValue: "xhigh" }],
      });
      yield* coordinator.publishLiveConfiguration(identity.instanceId, {
        models,
        currentModelId: "glm",
        configOptions: [narrowThinking],
      });
      // Another instance's sessions never reach this one.
      yield* coordinator.publishLiveConfiguration(otherInstance, {
        models,
        currentModelId: "opus",
        configOptions: [narrowThinking],
      });

      const live = applyAcpRegistryLiveConfiguration(
        probedSnapshot(null, []),
        yield* liveConfiguration(),
        [],
      );
      expect(thinkingChoices(live)).toEqual({ opus: WIDE_LEVELS, glm: NARROW_LEVELS });
      expect(thinkingCurrentValue(live, "opus")).toBe("xhigh");

      // A refresh probes Opus again; the newest GLM session must not replace its list.
      const refreshed = applyAcpRegistryLiveConfiguration(
        probedSnapshot("opus", [wideThinking]),
        yield* liveConfiguration(),
        [],
      );
      expect(thinkingChoices(refreshed)).toEqual({ opus: WIDE_LEVELS, glm: NARROW_LEVELS });

      // A session on an unlisted model adds nothing and removes nothing.
      yield* coordinator.publishLiveConfiguration(identity.instanceId, {
        models,
        currentModelId: null,
        configOptions: [{ ...narrowThinking, id: "unrelated" }],
      });
      expect(
        thinkingChoices(
          applyAcpRegistryLiveConfiguration(
            probedSnapshot("opus", [wideThinking]),
            yield* liveConfiguration(),
            [],
          ),
        ),
      ).toEqual({ opus: WIDE_LEVELS, glm: NARROW_LEVELS });
    }).pipe(Effect.provide(AcpRegistryRuntimeCoordinator.layer)),
  );

  it("keeps a model's probed options when a later probe starts on another model", () => {
    const firstProbe = probedSnapshot("opus", [wideThinking]);
    const probed = recordAcpRegistryModelOptions(new Map(), {
      models,
      currentModelId: "opus",
      configOptions: [wideThinking],
    });
    expect(thinkingChoices(applyAcpRegistryModelOptions(firstProbe, probed))).toEqual({
      opus: WIDE_LEVELS,
      glm: [],
    });

    const laterProbe = probedSnapshot("glm", [narrowThinking]);
    const reprobed = recordAcpRegistryModelOptions(probed, {
      models,
      currentModelId: "glm",
      configOptions: [narrowThinking],
    });
    expect(thinkingChoices(applyAcpRegistryModelOptions(laterProbe, reprobed))).toEqual({
      opus: WIDE_LEVELS,
      glm: NARROW_LEVELS,
    });
  });

  it("maps registry inspection status to provider readiness", () => {
    expect(
      acpRegistrySnapshotReadiness({
        status: "ready",
        agentId: "gemini-cli",
        version: "1.2.3",
        distribution: "npx",
      }),
    ).toEqual({ installed: true, version: "1.2.3", status: "ready" });

    expect(
      acpRegistrySnapshotReadiness({
        status: "missing_runner",
        agentId: "gemini-cli",
        version: "1.2.3",
        distribution: "npx",
        runner: "npx",
      }),
    ).toMatchObject({ installed: false, version: "1.2.3", status: "error" });

    expect(
      acpRegistrySnapshotReadiness({
        status: "missing_runner",
        version: null,
        distribution: "local",
      }),
    ).toEqual({
      installed: false,
      version: null,
      status: "error",
      message: "Local ACP executable is not available on this environment's PATH.",
    });

    expect(
      acpRegistrySnapshotReadiness({
        status: "unprepared",
        agentId: "zed-agent",
        version: "2.0.0",
        distribution: "binary",
      }),
    ).toMatchObject({ installed: false, version: "2.0.0", status: "warning" });

    expect(
      acpRegistrySnapshotReadiness({ status: "failed", message: "Registry unavailable." }),
    ).toEqual({
      installed: false,
      version: null,
      status: "error",
      message: "Registry unavailable.",
    });
  });

  it("projects discovery without claiming authentication when no login methods are advertised", () => {
    const snapshot = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({
        agentId: "test-agent",
        customModels: [" custom-model ", "gpt-discovered"],
      }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "npx",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models: [{ id: "gpt-discovered", name: "GPT Discovered", description: null }],
          currentModelId: "gpt-discovered",
          configOptions: [],
          sessionManagement: noSessionManagement,
        },
        slashCommands: [{ name: "plan", description: "Create a plan", input: { hint: "topic" } }],
        skills: [{ name: "workspace-skill", path: "acp://skill/workspace-skill", enabled: true }],
      },
    });

    expect(snapshot.auth).toEqual({ status: "unknown", canLogout: false });
    expect(snapshot.supportsTextGeneration).toBe(false);
    expect(
      snapshot.models.map(({ slug, name, isCustom, isDefault }) => ({
        slug,
        name,
        isCustom,
        isDefault,
      })),
    ).toEqual([
      {
        slug: "gpt-discovered",
        name: "GPT Discovered",
        isCustom: false,
        isDefault: true,
      },
      {
        slug: "custom-model",
        name: "custom-model",
        isCustom: true,
        isDefault: undefined,
      },
    ]);
    expect(snapshot.slashCommands).toEqual([
      { name: "plan", description: "Create a plan", input: { hint: "topic" } },
    ]);
    expect(snapshot.skills).toEqual([
      { name: "workspace-skill", path: "acp://skill/workspace-skill", enabled: true },
    ]);
  });

  it("keeps a default model only when the agent advertises none", () => {
    const snapshot = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "test-agent" }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "uvx",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models: [],
          currentModelId: null,
          configOptions: [],
          sessionManagement: noSessionManagement,
        },
        slashCommands: [],
        skills: [],
      },
    });

    expect(snapshot.models.map((model) => model.slug)).toEqual(["default"]);
    expect(snapshot.models[0]?.isDefault).toBe(true);
  });

  it.each(["registry", "local"] as const)(
    "reports failed authentication after successful %s inspection",
    (source) => {
      const snapshot = buildCheckedAcpRegistrySnapshot({
        ...identity,
        settings: decodeSettings({
          source,
          ...(source === "local" ? { commandPath: "test-agent" } : { agentId: "test-agent" }),
          authMethodId: "grok-login",
        }),
        checkedAt: "2026-08-13T10:00:00.000Z",
        inspection: {
          status: "ready",
          agentId: "test-agent",
          version: source === "local" ? null : "1.0.0",
          distribution: source === "local" ? "local" : "binary",
        },
        probeError: new AcpRegistryOperationError({
          reason: "authentication_failed",
          message: "Login required.",
          authMethods: [
            {
              id: "api-key",
              name: "API key",
              description: null,
              type: "env_var",
            },
            {
              id: "grok-login",
              name: "Log in with Grok",
              description: null,
              type: "agent",
            },
          ],
        }),
      });

      expect(snapshot).toMatchObject({
        installed: true,
        version: source === "local" ? null : "1.0.0",
        status: "warning",
        setup: { canAuthenticate: true },
        auth: {
          status: "unauthenticated",
          type: "agent",
          label: "Log in with Grok",
        },
        message: 'Sign in in provider settings using "Log in with Grok".',
      });
    },
  );

  it.effect("runs the disposable probe only after local inspection is ready", () =>
    Effect.gen(function* () {
      const settings = decodeSettings({ agentId: "test-agent" });
      const environment = { PATH: "/provider/bin" };
      let receivedEnvironment: NodeJS.ProcessEnv | undefined;
      const snapshot = yield* checkAcpRegistryProviderStatus(
        {
          ...identity,
          settings,
          cwd: "/workspace",
          environment,
        },
        (input) =>
          Effect.sync(() => {
            receivedEnvironment = input.environment;
            return {
              probe: {
                instanceId: identity.instanceId,
                ready: true as const,
                icon: null,
                authMethods: [],
                models: [{ id: "agent-model", name: "Agent Model", description: null }],
                currentModelId: "agent-model",
                configOptions: [],
                sessionManagement: noSessionManagement,
              },
              slashCommands: [{ name: "review" }],
              skills: [],
            };
          }),
      ).pipe(
        Effect.provideService(
          AcpRegistrySupport.AcpRegistryCatalog,
          catalogWithInspection({
            status: "ready",
            agentId: "test-agent",
            version: "1.0.0",
            distribution: "npx",
          }),
        ),
      );

      expect(receivedEnvironment).toBe(environment);
      expect(snapshot).toMatchObject({
        auth: { status: "unknown" },
        models: [{ slug: "agent-model" }],
        slashCommands: [{ name: "review" }],
        skills: [],
      });
    }),
  );

  it.effect("publishes concrete local readiness before background ACP discovery", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkAcpRegistryProviderReadiness({
        ...identity,
        settings: decodeSettings({ agentId: "test-agent" }),
        environment: { PATH: "/provider/bin" },
      }).pipe(
        Effect.provideService(
          AcpRegistrySupport.AcpRegistryCatalog,
          catalogWithInspection({
            status: "ready",
            agentId: "test-agent",
            version: "1.0.0",
            distribution: "npx",
          }),
        ),
      );

      expect(snapshot).toMatchObject({
        installed: true,
        status: "ready",
        version: "1.0.0",
        auth: { status: "unknown" },
        message: "Checking ACP authentication, models, and commands in the background...",
      });
    }),
  );
});
