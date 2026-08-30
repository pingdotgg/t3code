import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ENVIRONMENT_MCP_MAX_DIAGNOSTIC_CHARACTERS,
  ENVIRONMENT_MCP_MAX_WRITING_INSTRUCTIONS,
  EnvironmentId,
  EnvironmentMcpReadResult,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { makeProviderRegistryLayer } from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import { EnvironmentMcpService, layer } from "./EnvironmentMcpService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

const encodeEnvironmentMcpReadResult = Schema.encodeUnknownEffect(EnvironmentMcpReadResult);
const encodeUnknownJsonString = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const environmentId = EnvironmentId.make("environment-test");
const scope: McpInvocationScope = {
  environmentId,
  threadId: ThreadId.make("thread-test"),
  providerSessionId: "provider-session-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};

const provider = (input: {
  readonly instanceId: string;
  readonly displayName?: string;
  readonly version?: string | null;
  readonly status?: ServerProvider["status"];
  readonly availability?: ServerProvider["availability"];
  readonly enabled?: boolean;
  readonly installed?: boolean;
  readonly modelCount?: number;
}): ServerProvider => ({
  instanceId: ProviderInstanceId.make(input.instanceId),
  driver: ProviderDriverKind.make("codex"),
  ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
  enabled: input.enabled ?? true,
  installed: input.installed ?? true,
  version: input.version ?? "1.0.0",
  status: input.status ?? "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-08-29T00:00:00.000Z",
  ...(input.availability === undefined ? {} : { availability: input.availability }),
  models: Array.from({ length: input.modelCount ?? 0 }, (_, index) => ({
    slug: `model-${index}`,
    name: `Sensitive model name ${index}`,
    isCustom: false,
    capabilities: null,
  })),
  slashCommands: [],
  skills: [],
  message: "SENTINEL_PROVIDER_RAW_DIAGNOSTIC",
});

const environmentLayer = (label: string, serverVersion: string) =>
  Layer.succeed(
    ServerEnvironment.ServerEnvironment,
    ServerEnvironment.ServerEnvironment.of({
      getEnvironmentId: Effect.succeed(environmentId),
      getDescriptor: Effect.succeed({
        environmentId,
        label,
        platform: { os: "darwin", arch: "arm64" },
        serverVersion,
        capabilities: {
          repositoryIdentity: true,
          attachmentUploads: true,
          fileAttachments: { maxUploadBytes: 1234 },
          serverSelfUpdate: "boot-service",
          agentActivityPublishing: true,
        },
      }),
    }),
  );

const serviceLayer = (input: {
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly label?: string;
  readonly serverVersion?: string;
  readonly customInstructions?: string;
}) =>
  layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        environmentLayer(input.label ?? "Test environment", input.serverVersion ?? "1.2.3"),
        makeProviderRegistryLayer(input.providers ?? []),
        ServerSettings.layerTest({
          enableAgentBrowserAccess: true,
          addProjectBaseDirectory: "/SENTINEL_PRIVATE_PATH",
          observability: {
            otlpTracesUrl: "https://SENTINEL_PRIVATE_OBSERVABILITY",
          },
          providerInstances: {
            [ProviderInstanceId.make("sentinel")]: {
              driver: ProviderDriverKind.make("codex"),
              config: {},
              environment: [
                {
                  name: "SENTINEL_SECRET_ENVIRONMENT",
                  value: "SENTINEL_SECRET_VALUE",
                  sensitive: true,
                },
              ],
            },
          },
          sourceControlWritingStyle: {
            mode: "custom",
            customInstructions: input.customInstructions ?? "Keep commit messages concise.",
            followChangeRequestTemplates: true,
          },
        }),
      ),
    ),
  );

describe("EnvironmentMcpService", () => {
  it.effect("returns only bounded allowlisted environment and provider diagnostics", () =>
    Effect.gen(function* () {
      const service = yield* EnvironmentMcpService;
      const result = yield* service.read(scope, { providerLimit: 1 });
      const encoded = yield* encodeEnvironmentMcpReadResult(result);

      expect(result.identity.label).toEqual({
        text: "😀".repeat(ENVIRONMENT_MCP_MAX_DIAGNOSTIC_CHARACTERS),
        characters: ENVIRONMENT_MCP_MAX_DIAGNOSTIC_CHARACTERS + 3,
        maximumCharacters: ENVIRONMENT_MCP_MAX_DIAGNOSTIC_CHARACTERS,
        truncated: true,
      });
      expect(result.identity.serverVersion).toEqual(result.identity.label);
      expect(result.providers.map((item) => item.instanceId)).toEqual([
        ProviderInstanceId.make("a-provider"),
      ]);
      expect(result.providerNextCursor).toBe(1);
      expect(result.providerTotal).toBe(2);
      expect(result.providerHealth).toMatchObject({
        status: "degraded",
        total: 2,
        ready: 1,
        warning: 1,
        unavailable: 1,
        usable: 1,
      });
      expect(result.preferences.sourceControlWritingStyle.customInstructions).toEqual({
        text: "🧪".repeat(ENVIRONMENT_MCP_MAX_WRITING_INSTRUCTIONS),
        characters: ENVIRONMENT_MCP_MAX_WRITING_INSTRUCTIONS + 2,
        maximumCharacters: ENVIRONMENT_MCP_MAX_WRITING_INSTRUCTIONS,
        truncated: true,
      });

      const serialized = encodeUnknownJsonString(encoded);
      expect(serialized).not.toContain("SENTINEL_");
      expect(serialized).not.toContain("Sensitive model name");
      expect(serialized).not.toContain("serverSelfUpdate");
      expect(serialized).not.toContain("agentActivityPublishing");
    }).pipe(
      Effect.provide(
        serviceLayer({
          providers: [
            provider({
              instanceId: "z-provider",
              displayName: "😀".repeat(ENVIRONMENT_MCP_MAX_DIAGNOSTIC_CHARACTERS + 3),
              version: "😀".repeat(ENVIRONMENT_MCP_MAX_DIAGNOSTIC_CHARACTERS + 3),
              modelCount: 2,
            }),
            provider({
              instanceId: "a-provider",
              status: "warning",
              availability: "unavailable",
              enabled: false,
              installed: false,
            }),
          ],
          label: "😀".repeat(ENVIRONMENT_MCP_MAX_DIAGNOSTIC_CHARACTERS + 3),
          serverVersion: "😀".repeat(ENVIRONMENT_MCP_MAX_DIAGNOSTIC_CHARACTERS + 3),
          customInstructions: "🧪".repeat(ENVIRONMENT_MCP_MAX_WRITING_INSTRUCTIONS + 2),
        }),
      ),
    ),
  );

  it.effect("denies credentials without orchestration capability before reading services", () => {
    let providerReads = 0;
    const providerLayer = Layer.succeed(ProviderRegistry, {
      getProviders: Effect.sync(() => {
        providerReads += 1;
        return [];
      }),
    } as never);
    return Effect.gen(function* () {
      const service = yield* EnvironmentMcpService;
      const error = yield* Effect.flip(service.read({ ...scope, capabilities: new Set() }, {}));
      expect(error.code).toBe("capability_denied");
      expect(providerReads).toBe(0);
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              environmentLayer("Test", "1.0.0"),
              providerLayer,
              ServerSettings.layerTest({}),
            ),
          ),
        ),
      ),
    );
  });

  it.effect("distinguishes an unavailable provider registry from a healthy empty result", () => {
    const unavailableRegistry = Layer.succeed(ProviderRegistry, {
      getProviders: Effect.die("SENTINEL_PROVIDER_FAILURE"),
    } as never);
    return Effect.gen(function* () {
      const service = yield* EnvironmentMcpService;
      const error = yield* Effect.flip(service.read(scope, {}));
      expect(error.code).toBe("provider_registry_unavailable");
      expect(error.message).not.toContain("SENTINEL_PROVIDER_FAILURE");
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              environmentLayer("Test", "1.0.0"),
              unavailableRegistry,
              ServerSettings.layerTest(DEFAULT_SERVER_SETTINGS),
            ),
          ),
        ),
      ),
    );
  });

  it.effect("distinguishes a credential environment mismatch from service unavailability", () =>
    Effect.gen(function* () {
      const service = yield* EnvironmentMcpService;
      const error = yield* Effect.flip(
        service.read({ ...scope, environmentId: EnvironmentId.make("environment-other") }, {}),
      );
      expect(error.code).toBe("environment_mismatch");
      expect(error.message).toBe("The MCP credential does not belong to the running environment.");
    }).pipe(Effect.provide(serviceLayer({}))),
  );
});
