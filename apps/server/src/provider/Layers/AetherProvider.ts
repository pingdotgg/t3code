/**
 * AetherProvider — snapshot/probe helpers for the Aether cloud-task driver.
 *
 * Aether is a cloud API, not a local CLI: `installed` is always `true`,
 * `version` is always `null`, and the probe is a single authenticated
 * `GET {apiBaseUrl}/profile`. Models never come from the wire — Aether has no
 * runtime catalog endpoint — so every draft path (pending, disabled, error,
 * ready) carries the vendored platform catalog plus the instance's custom
 * models.
 *
 * @module provider/Layers/AetherProvider
 */
import type { AetherSettings, ModelCapabilities, ServerProviderModel } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { createModelCapabilities } from "@t3tools/shared/model";
import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  AETHER_AGENT_TYPES,
  AETHER_DEFAULT_AGENT_TYPE,
  AETHER_PLATFORM_CATALOG,
  defaultReasoningEffortForModel,
  reasoningEffortsForModel,
  type AetherAgentType,
} from "./aether/vendored/catalog.ts";

const AETHER_PRESENTATION = {
  displayName: "Aether",
  // Parity with the web driver metadata (providerDriverMeta.ts): every
  // instance of the driver advertises the early-access gate.
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
} as const;

/** Sensitive instance environment variable carrying the Aether API key. */
export const AETHER_API_KEY_ENV_VAR = "AETHER_API_KEY";

const PROBE_TIMEOUT_MS = 10_000;

/**
 * The subset of the Aether `GET /profile` response the probe reads. The full
 * response (`handlers.ProfileResponse`) carries id/email/display_name/
 * onboarding_completed/created_at/updated_at and deliberately no billing
 * fields; only `email` feeds the probe message.
 */
export const AetherProfileResponse = Schema.Struct({
  email: Schema.optional(Schema.String),
});
export type AetherProfileResponse = typeof AetherProfileResponse.Type;
const decodeAetherProfile = Schema.decodeUnknownEffect(AetherProfileResponse);

function titleCaseEffort(value: string): string {
  switch (value) {
    case "xhigh":
      return "Extra High";
    default:
      return value.charAt(0).toUpperCase() + value.slice(1);
  }
}

function aetherModelCapabilities(agentType: AetherAgentType, modelSlug: string): ModelCapabilities {
  const efforts = reasoningEffortsForModel(agentType, modelSlug);
  const defaultEffort = defaultReasoningEffortForModel(agentType, modelSlug);
  return createModelCapabilities({
    optionDescriptors:
      efforts.length === 0
        ? []
        : [
            buildSelectOptionDescriptor({
              id: "reasoningEffort",
              label: "Reasoning effort",
              options: efforts.map((effort) => ({
                value: effort,
                label: titleCaseEffort(effort),
                ...(effort === defaultEffort ? { isDefault: true } : {}),
              })),
            }),
          ],
  });
}

/**
 * The vendored catalog flattened into t3 model entries. Slugs are the stable
 * composite `<agent_type>/<model_slug>` (they key preferences and thread
 * selections). Exactly one entry is the default: the default agent type's
 * default model.
 */
export function aetherCatalogModels(): ReadonlyArray<ServerProviderModel> {
  const models: Array<ServerProviderModel> = [];
  for (const agentType of AETHER_AGENT_TYPES) {
    const agent = AETHER_PLATFORM_CATALOG.agents[agentType];
    for (const model of agent.models) {
      const isDefault =
        agentType === AETHER_DEFAULT_AGENT_TYPE && model.slug === agent.defaultModel;
      models.push({
        slug: `${agentType}/${model.slug}`,
        name: model.name,
        subProvider: agent.label,
        isCustom: false,
        ...(isDefault ? { isDefault: true } : {}),
        capabilities: aetherModelCapabilities(agentType, model.slug),
      });
    }
  }
  return models;
}

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

/**
 * All models for one instance: the vendored catalog plus the instance's
 * user-added custom models (no capabilities — Aether accepts or rejects them
 * at dispatch time; the vendored catalog only goes stale until the next sync).
 */
export function aetherModels(aetherSettings: AetherSettings): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    aetherCatalogModels(),
    aetherSettings.customModels,
    EMPTY_CAPABILITIES,
  );
}

/** The API key from a merged instance environment, or undefined when absent/blank. */
export function readAetherApiKey(environment: NodeJS.ProcessEnv): string | undefined {
  const key = environment[AETHER_API_KEY_ENV_VAR]?.trim();
  return key !== undefined && key.length > 0 ? key : undefined;
}

const MISSING_KEY_MESSAGE = `No Aether API key configured. Add a sensitive ${AETHER_API_KEY_ENV_VAR} environment variable to this provider instance.`;

/** Instant zero-I/O draft published while the first probe runs. */
export const makePendingAetherProvider = (
  aetherSettings: AetherSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = aetherModels(aetherSettings);

    if (!aetherSettings.enabled) {
      return buildServerProvider({
        presentation: AETHER_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          // Cloud API — there is no binary to install, ever.
          installed: true,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Aether is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: AETHER_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Aether provider status has not been checked in this session yet.",
      },
    });
  });

/**
 * Probe the Aether API: `GET {apiBaseUrl}/profile` with the instance's
 * `AETHER_API_KEY` as a bearer token. Never fails — every outcome becomes a
 * draft with an explicit status and reason. 401 (bad key) is deliberately
 * distinguished from transport failures and other statuses.
 */
export const checkAetherProviderStatus = Effect.fn("checkAetherProviderStatus")(function* (
  aetherSettings: AetherSettings,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<ServerProviderDraft, never, HttpClient.HttpClient> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const models = aetherModels(aetherSettings);

  const draft = (probe: {
    readonly status: "ready" | "warning" | "error";
    readonly auth: ServerProviderDraft["auth"];
    readonly message: string;
  }): ServerProviderDraft =>
    buildServerProvider({
      presentation: AETHER_PRESENTATION,
      enabled: aetherSettings.enabled,
      checkedAt,
      models,
      probe: {
        // Cloud API — no local binary, so "installed" is unconditionally
        // true and the status copy never says "Sign in via the CLI".
        installed: true,
        version: null,
        status: probe.status,
        auth: probe.auth,
        message: probe.message,
      },
    });

  if (!aetherSettings.enabled) {
    return draft({
      status: "warning",
      auth: { status: "unknown" },
      message: "Aether is disabled in T3 Code settings.",
    });
  }

  const apiKey = readAetherApiKey(environment);
  if (apiKey === undefined) {
    return draft({
      status: "error",
      auth: { status: "unauthenticated" },
      message: MISSING_KEY_MESSAGE,
    });
  }

  const client = yield* HttpClient.HttpClient;
  const baseUrl = aetherSettings.apiBaseUrl.replace(/\/+$/, "");
  const request = HttpClientRequest.get(`${baseUrl}/profile`).pipe(
    HttpClientRequest.setHeader("accept", "application/json"),
    HttpClientRequest.setHeader("authorization", `Bearer ${apiKey}`),
  );

  // ONE deadline over the whole exchange, body included: a `/profile` that
  // answers with 2xx headers and then stalls mid-body would hang the probe
  // forever if only `execute` were timed. A malformed payload is a distinct
  // answer, so it is caught INSIDE the deadline rather than folded into it.
  const probeExit = yield* Effect.exit(
    Effect.gen(function* () {
      const response = yield* client.execute(request);
      if (response.status === 401) {
        return { _tag: "unauthenticated" } as const;
      }
      if (response.status < 200 || response.status >= 300) {
        return { _tag: "http-status", status: response.status } as const;
      }
      const decoded = yield* Effect.result(response.json.pipe(Effect.flatMap(decodeAetherProfile)));
      return Result.isSuccess(decoded)
        ? ({ _tag: "profile", profile: decoded.success } as const)
        : ({ _tag: "malformed-profile" } as const);
    }).pipe(Effect.timeout(PROBE_TIMEOUT_MS)),
  );
  if (Exit.isFailure(probeExit)) {
    return draft({
      status: "error",
      auth: { status: "unknown" },
      message: `Couldn't reach the Aether API at ${baseUrl}. Check the API base URL and your network connection.`,
    });
  }

  const probeResult = probeExit.value;
  if (probeResult._tag === "unauthenticated") {
    return draft({
      status: "error",
      auth: { status: "unauthenticated" },
      message:
        "Invalid Aether API key. Update the AETHER_API_KEY environment variable on this instance.",
    });
  }
  if (probeResult._tag === "http-status") {
    return draft({
      status: "error",
      auth: { status: "unknown" },
      message: `Aether API returned HTTP ${probeResult.status} from ${baseUrl}/profile.`,
    });
  }
  if (probeResult._tag === "malformed-profile") {
    return draft({
      status: "error",
      auth: { status: "unknown" },
      message: "Aether API returned an unexpected /profile payload.",
    });
  }

  const profile = probeResult.profile;
  const email = profile.email?.trim();
  return draft({
    status: "ready",
    auth: {
      status: "authenticated",
      type: "aether",
      ...(email ? { email } : {}),
    },
    message: email ? `Connected to Aether as ${email}.` : "Connected to Aether.",
  });
});
