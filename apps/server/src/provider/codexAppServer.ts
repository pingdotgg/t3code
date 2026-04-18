import type {
  ModelCapabilities,
  ServerProviderModel,
  ServerProviderSkill,
} from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import * as CodexClient from "effect-codex-app-server/client";
import type * as EffectCodexSchema from "effect-codex-app-server/schema";
import type { Mutable } from "effect/Types";

export interface CodexAppServerProviderSnapshot {
  readonly account: EffectCodexSchema.V2GetAccountResponse;
  readonly version: string | undefined;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}

const REASONING_EFFORT_LABELS: Record<
  EffectCodexSchema.V2ModelListResponse__ReasoningEffort,
  string
> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
};

export function codexAccountAuthLabel(account: EffectCodexSchema.V2GetAccountResponse["account"]) {
  if (!account) return undefined;
  if (account.type === "apiKey") return "OpenAI API Key";

  switch (account.planType) {
    case "free":
      return "ChatGPT Free Subscription";
    case "go":
      return "ChatGPT Go Subscription";
    case "plus":
      return "ChatGPT Plus Subscription";
    case "pro":
      return "ChatGPT Pro Subscription";
    case "team":
      return "ChatGPT Team Subscription";
    case "self_serve_business_usage_based":
    case "business":
      return "ChatGPT Business Subscription";
    case "enterprise_cbp_usage_based":
    case "enterprise":
      return "ChatGPT Enterprise Subscription";
    case "edu":
      return "ChatGPT Edu Subscription";
    case "unknown":
      return "ChatGPT Subscription";
    default:
      account.planType satisfies never;
      return undefined;
  }
}

function mapCodexModelCapabilities(
  model: EffectCodexSchema.V2ModelListResponse__Model,
): ModelCapabilities {
  return {
    reasoningEffortLevels: model.supportedReasoningEfforts.map(({ reasoningEffort }) => ({
      value: reasoningEffort,
      label: REASONING_EFFORT_LABELS[reasoningEffort],
      ...(reasoningEffort === model.defaultReasoningEffort ? { isDefault: true } : {}),
    })),
    supportsFastMode: (model.additionalSpeedTiers ?? []).includes("fast"),
    supportsThinkingToggle: false,
    contextWindowOptions: [],
    promptInjectedEffortLevels: [],
  };
}

const toDisplayName = (model: EffectCodexSchema.V2ModelListResponse__Model): string => {
  // Capitalize 'gpt' to 'GPT-' and capitalize any letter following a dash
  return model.displayName
    .replace(/^gpt/i, "GPT") // Handle start with 'gpt' or 'GPT'
    .replace(/-([a-z])/g, (_, c) => "-" + c.toUpperCase());
};

function parseCodexModelListResponse(
  response: EffectCodexSchema.V2ModelListResponse,
): ReadonlyArray<ServerProviderModel> {
  return response.data.map((model) => ({
    slug: model.model,
    name: toDisplayName(model),
    isCustom: false,
    capabilities: mapCodexModelCapabilities(model),
  }));
}

function appendCustomCodexModels(
  models: ReadonlyArray<ServerProviderModel>,
  customModels: ReadonlyArray<string>,
): ReadonlyArray<ServerProviderModel> {
  if (customModels.length === 0) {
    return models;
  }

  const seen = new Set(models.map((model) => model.slug));
  const fallbackCapabilities = models.find((model) => model.capabilities)?.capabilities ?? null;
  const customEntries: ServerProviderModel[] = [];
  for (const rawModel of customModels) {
    const slug = rawModel.trim();
    if (!slug || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    customEntries.push({
      slug,
      name: slug,
      isCustom: true,
      capabilities: fallbackCapabilities,
    });
  }
  return customEntries.length === 0 ? models : [...models, ...customEntries];
}

function parseCodexSkillsListResponse(
  response: EffectCodexSchema.V2SkillsListResponse,
  cwd: string,
): ReadonlyArray<ServerProviderSkill> {
  const matchingEntry = response.data.find((entry) => entry.cwd === cwd);
  const skills = matchingEntry
    ? matchingEntry.skills
    : response.data.flatMap((entry) => entry.skills);

  return skills.map((skill) => {
    const shortDescription =
      skill.shortDescription ?? skill.interface?.shortDescription ?? undefined;

    const parsedSkill: Mutable<ServerProviderSkill> = {
      name: skill.name,
      path: skill.path,
      enabled: skill.enabled,
    };

    if (skill.description) {
      parsedSkill.description = skill.description;
    }
    if (skill.scope) {
      parsedSkill.scope = skill.scope;
    }
    if (skill.interface?.displayName) {
      parsedSkill.displayName = skill.interface.displayName;
    }
    if (shortDescription) {
      parsedSkill.shortDescription = shortDescription;
    }

    return parsedSkill;
  });
}

export function buildCodexInitializeParams(): EffectCodexSchema.V1InitializeParams {
  return {
    clientInfo: {
      name: "t3code_desktop",
      title: "T3 Code Desktop",
      version: "0.1.0",
    },
    capabilities: {
      experimentalApi: true,
    },
  };
}

const requestAllCodexModels = Effect.fn("requestAllCodexModels")(function* (
  client: CodexClient.CodexAppServerClientShape,
) {
  const models: ServerProviderModel[] = [];
  let cursor: string | null | undefined = undefined;

  do {
    const response: EffectCodexSchema.V2ModelListResponse = yield* client.request(
      "model/list",
      cursor ? { cursor } : {},
    );
    models.push(...parseCodexModelListResponse(response));
    cursor = response.nextCursor;
  } while (cursor);

  return models;
});

export const probeCodexAppServerProvider = Effect.fn("probeCodexAppServerProvider")(
  function* (input: {
    readonly binaryPath: string;
    readonly homePath?: string;
    readonly cwd: string;
    readonly customModels?: ReadonlyArray<string>;
  }) {
    const clientContext = yield* Layer.build(
      CodexClient.layerCommand({
        command: input.binaryPath,
        args: ["app-server"],
        cwd: input.cwd,
        ...(input.homePath ? { env: { CODEX_HOME: input.homePath } } : {}),
      }),
    );
    const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
      Effect.provide(clientContext),
    );

    const initialize = yield* client.request("initialize", buildCodexInitializeParams());
    yield* client.notify("initialized", undefined);

    // Extract the version string after the first '/' in userAgent, up to the next space or the end
    const versionMatch = initialize.userAgent.match(/\/([^\s]+)/);
    const version = versionMatch ? versionMatch[1] : undefined;

    const accountResponse = yield* client.request("account/read", {});
    if (!accountResponse.account && accountResponse.requiresOpenaiAuth) {
      return {
        account: accountResponse,
        version,
        models: appendCustomCodexModels([], input.customModels ?? []),
        skills: [],
      } satisfies CodexAppServerProviderSnapshot;
    }

    const [skillsResponse, models] = yield* Effect.all(
      [
        client.request("skills/list", {
          cwds: [input.cwd],
        }),
        requestAllCodexModels(client),
      ],
      { concurrency: "unbounded" },
    );

    return {
      account: accountResponse,
      version,
      models: appendCustomCodexModels(models, input.customModels ?? []),
      skills: parseCodexSkillsListResponse(skillsResponse, input.cwd),
    } satisfies CodexAppServerProviderSnapshot;
  },
  Effect.scoped,
);
