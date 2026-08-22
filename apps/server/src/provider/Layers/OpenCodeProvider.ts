import type {
  ModelCapabilities,
  ServerProviderModel,
  ServerProviderSkill,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { createModelCapabilities } from "@t3tools/shared/model";
import {
  buildServerProvider,
  nonEmptyTrimmed,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import * as OpenCodeRuntime from "../opencodeRuntime.ts";

export interface OpenCodeProviderSettings {
  readonly enabled: boolean;
  readonly binaryPath: string;
  readonly customModels: ReadonlyArray<string>;
}

const OPENCODE_PRESENTATION = {
  displayName: "OpenCode",
  showInteractionModeToggle: false,
} as const;
const OPENCODE_PROVIDER_PROBE_TIMEOUT = "15 seconds";

const OpenCodeHealthSchema = Schema.Struct({
  healthy: Schema.optionalKey(Schema.Boolean),
  version: Schema.optionalKey(Schema.String),
  pid: Schema.optionalKey(Schema.Number),
});

const OpenCodeVariantSchema = Schema.Union([Schema.String, Schema.Struct({ id: Schema.String })]);

const OpenCodeModelSchema = Schema.Struct({
  id: Schema.String,
  providerID: Schema.String,
  name: Schema.String,
  enabled: Schema.optionalKey(Schema.Boolean),
  status: Schema.optionalKey(Schema.String),
  variants: Schema.optionalKey(
    Schema.Union([
      Schema.Array(OpenCodeVariantSchema),
      Schema.Record(Schema.String, Schema.Unknown),
    ]),
  ),
});

const OpenCodeModelListSchema = Schema.Union([
  Schema.Array(OpenCodeModelSchema),
  Schema.Struct({ data: Schema.Array(OpenCodeModelSchema) }),
]);

const OpenCodeDefaultModelSchema = Schema.Union([
  Schema.NullOr(OpenCodeModelSchema),
  Schema.Struct({ data: Schema.NullOr(OpenCodeModelSchema) }),
]);

const OpenCodeAgentSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mode: Schema.optionalKey(Schema.String),
  hidden: Schema.optionalKey(Schema.Boolean),
  description: Schema.optionalKey(Schema.String),
});

const OpenCodeAgentListSchema = Schema.Union([
  Schema.Array(OpenCodeAgentSchema),
  Schema.Struct({ data: Schema.Array(OpenCodeAgentSchema) }),
]);

const OpenCodeSkillSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  location: Schema.String,
});

const OpenCodeSkillListSchema = Schema.Union([
  Schema.Array(OpenCodeSkillSchema),
  Schema.Struct({ data: Schema.Array(OpenCodeSkillSchema) }),
]);

type OpenCodeModel = typeof OpenCodeModelSchema.Type;
type OpenCodeAgent = typeof OpenCodeAgentSchema.Type;
type OpenCodeSkill = typeof OpenCodeSkillSchema.Type;

const DEFAULT_OPENCODE_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

function responseList<A>(value: ReadonlyArray<A> | { readonly data: ReadonlyArray<A> }) {
  return "data" in value ? value.data : value;
}

function responseValue<A>(value: A | null | { readonly data: A | null }): A | null {
  return value !== null && typeof value === "object" && "data" in value ? value.data : value;
}

function titleCase(value: string): string {
  return value
    .split(/[-_/]+/u)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function variantIds(model: OpenCodeModel): ReadonlyArray<string> {
  if (!model.variants) return [];
  if (Array.isArray(model.variants)) {
    return model.variants.map((variant) => (typeof variant === "string" ? variant : variant.id));
  }
  return Object.keys(model.variants);
}

function modelCapabilities(
  model: OpenCodeModel,
  agents: ReadonlyArray<OpenCodeAgent>,
): ModelCapabilities {
  const variants = variantIds(model);
  const defaultVariant = variants.includes("default")
    ? "default"
    : variants.includes("medium")
      ? "medium"
      : variants.length === 1
        ? variants[0]
        : undefined;
  const visibleAgents = agents.filter(
    (agent) => agent.hidden !== true && agent.mode !== "subagent",
  );
  const defaultAgent =
    visibleAgents.find((agent) => agent.id === "build")?.id ?? visibleAgents[0]?.id;

  return createModelCapabilities({
    optionDescriptors: [
      ...(variants.length > 0
        ? [
            {
              id: "variant",
              label: "Variant",
              type: "select" as const,
              options: variants.map((variant) => ({
                id: variant,
                label: titleCase(variant),
                ...(variant === defaultVariant ? { isDefault: true as const } : {}),
              })),
              ...(defaultVariant ? { currentValue: defaultVariant } : {}),
            },
          ]
        : []),
      ...(visibleAgents.length > 0
        ? [
            {
              id: "agent",
              label: "Agent",
              type: "select" as const,
              options: visibleAgents.map((agent) => ({
                id: agent.id,
                label: nonEmptyTrimmed(agent.name) ?? titleCase(agent.id),
                ...(agent.id === defaultAgent ? { isDefault: true as const } : {}),
              })),
              ...(defaultAgent ? { currentValue: defaultAgent } : {}),
            },
          ]
        : []),
    ],
  });
}

function providerModels(input: {
  readonly models: ReadonlyArray<OpenCodeModel>;
  readonly defaultModel: OpenCodeModel | null;
  readonly agents: ReadonlyArray<OpenCodeAgent>;
}): ReadonlyArray<ServerProviderModel> {
  const defaultSlug = input.defaultModel
    ? `${input.defaultModel.providerID}/${input.defaultModel.id}`
    : null;
  return input.models
    .filter((model) => model.enabled !== false && model.status !== "deprecated")
    .map((model) => {
      const slug = `${model.providerID}/${model.id}`;
      return {
        slug,
        name: nonEmptyTrimmed(model.name) ?? model.id,
        subProvider: model.providerID,
        isCustom: false,
        ...(slug === defaultSlug ? { isDefault: true as const } : {}),
        capabilities: modelCapabilities(model, input.agents),
      };
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

function providerSkills(skills: ReadonlyArray<OpenCodeSkill>): ReadonlyArray<ServerProviderSkill> {
  return skills
    .flatMap((skill) => {
      const name = nonEmptyTrimmed(skill.name);
      const path = nonEmptyTrimmed(skill.location);
      if (!name || !path) return [];
      const description = nonEmptyTrimmed(skill.description ?? "");
      return [
        {
          name,
          path,
          enabled: true,
          ...(description ? { description, shortDescription: description } : {}),
        },
      ];
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

function failureSnapshot(input: {
  readonly settings: OpenCodeProviderSettings;
  readonly checkedAt: string;
  readonly cause: unknown;
  readonly version?: string | null;
}): ServerProviderDraft {
  const unsupported = OpenCodeRuntime.isOpenCodeUnsupportedPreviewError(input.cause);
  const missing = OpenCodeRuntime.isOpenCodeCommandNotFoundError(input.cause);
  const timedOut = OpenCodeRuntime.isOpenCodeTimeoutError(input.cause);
  return buildServerProvider({
    presentation: OPENCODE_PRESENTATION,
    enabled: input.settings.enabled,
    checkedAt: input.checkedAt,
    models: providerModelsFromSettings(
      [],
      input.settings.customModels,
      DEFAULT_OPENCODE_MODEL_CAPABILITIES,
    ),
    probe: {
      installed: !missing,
      version: input.version ?? null,
      status: "error",
      auth: { status: "unknown" },
      message: unsupported
        ? "This OpenCode 2 preview is not supported by T3 Code."
        : missing
          ? "OpenCode 2 CLI (`opencode2`) is not installed or not on PATH."
          : timedOut
            ? "OpenCode 2 provider discovery timed out."
            : input.cause instanceof Error
              ? input.cause.message
              : "Failed to connect to the OpenCode 2 background service.",
    },
  });
}

export const buildInitialOpenCodeProviderSnapshot = (
  settings: OpenCodeProviderSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return buildServerProvider({
      presentation: OPENCODE_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: providerModelsFromSettings(
        [],
        settings.customModels,
        DEFAULT_OPENCODE_MODEL_CAPABILITIES,
      ),
      probe: settings.enabled
        ? {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "OpenCode 2 provider status has not been checked in this session yet.",
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "OpenCode 2 is disabled in T3 Code settings.",
          },
    });
  });

export const checkOpenCodeProviderStatus = Effect.fn("checkOpenCodeProviderStatus")(function* (
  settings: OpenCodeProviderSettings,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ServerProviderDraft, never, OpenCodeRuntime.OpenCodeRuntime> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled) return yield* buildInitialOpenCodeProviderSnapshot(settings);

  const runtime = yield* OpenCodeRuntime.OpenCodeRuntime;
  const attached = yield* Effect.exit(
    Effect.gen(function* () {
      const connection = yield* runtime.attach({
        binaryPath: settings.binaryPath || "opencode2",
        ...(environment ? { environment } : {}),
      });
      const [health, modelsResponse, defaultResponse, agentsResponse, skillsResponse] =
        yield* Effect.all(
          [
            connection.request("GET", "/api/health", {
              operation: "health.get",
              schema: OpenCodeHealthSchema,
            }),
            connection.request("GET", "/api/model", {
              operation: "model.list",
              schema: OpenCodeModelListSchema,
            }),
            connection
              .request("GET", "/api/model/default", {
                operation: "model.default",
                schema: OpenCodeDefaultModelSchema,
              })
              .pipe(Effect.orElseSucceed(() => null)),
            connection
              .request("GET", "/api/agent", {
                operation: "agent.list",
                schema: OpenCodeAgentListSchema,
              })
              .pipe(Effect.orElseSucceed(() => [])),
            connection
              .request("GET", "/api/skill", {
                operation: "skill.list",
                schema: OpenCodeSkillListSchema,
              })
              .pipe(Effect.orElseSucceed(() => [])),
          ],
          { concurrency: "unbounded" },
        );
      return {
        health,
        models: responseList(modelsResponse),
        defaultModel: responseValue(defaultResponse),
        agents: responseList(agentsResponse),
        skills: responseList(skillsResponse),
      };
    }).pipe(Effect.timeoutOption(OPENCODE_PROVIDER_PROBE_TIMEOUT)),
  );
  if (Exit.isFailure(attached)) {
    return failureSnapshot({
      settings,
      checkedAt,
      cause: Cause.squash(attached.cause),
    });
  }

  if (Option.isNone(attached.value)) {
    return failureSnapshot({
      settings,
      checkedAt,
      cause: new OpenCodeRuntime.OpenCodeTimeoutError({
        operation: "provider.probe",
      }),
    });
  }

  const value = attached.value.value;
  const discoveredModels = providerModels(value);
  const skills = providerSkills(value.skills);
  const models = providerModelsFromSettings(
    discoveredModels,
    settings.customModels,
    DEFAULT_OPENCODE_MODEL_CAPABILITIES,
  );
  const providerCount = new Set(
    discoveredModels.map((model) => model.subProvider).filter((provider) => provider !== undefined),
  ).size;
  const healthy = value.health.healthy !== false;
  return buildServerProvider({
    presentation: OPENCODE_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    skills,
    probe: {
      installed: true,
      version: value.health.version ?? null,
      status: healthy && models.length > 0 ? "ready" : "warning",
      auth: { status: "authenticated", type: "opencode" },
      message: !healthy
        ? "The OpenCode 2 background service reported that it is unhealthy."
        : providerCount > 0
          ? `${providerCount} upstream provider${providerCount === 1 ? "" : "s"} available through the OpenCode 2 background service.`
          : models.length > 0
            ? "Connected to OpenCode 2 using the custom models configured in T3 Code."
            : "Connected to OpenCode 2, but it did not report any available models.",
    },
  });
});
