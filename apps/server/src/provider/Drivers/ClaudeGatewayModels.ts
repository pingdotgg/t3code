import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcess } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  spawnAndCollect,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import { readClaudeConnectionSettings } from "./ClaudeSkills.ts";
import { makeClaudeEnvironment } from "./ClaudeHome.ts";

const GatewayModels = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      display_name: Schema.optional(Schema.String),
    }),
  ),
  has_more: Schema.optional(Schema.Boolean),
  last_id: Schema.optional(Schema.NullOr(Schema.String)),
});
type GatewayModel = (typeof GatewayModels.Type)["data"][number];

export const discoverClaudeGatewayModels = Effect.fn("discoverClaudeGatewayModels")(
  function* (
    config: Pick<ClaudeSettings, "homePath">,
    environment: NodeJS.ProcessEnv,
    cwd?: string,
  ) {
    const claudeEnvironment = yield* makeClaudeEnvironment(config, environment);
    const { env, apiKeyHelper } = yield* readClaudeConnectionSettings(
      config,
      cwd,
      claudeEnvironment,
    );
    const endpoint = URL.parse(env.ANTHROPIC_BASE_URL?.trim() ?? "");
    if (
      !endpoint ||
      !["http:", "https:"].includes(endpoint.protocol) ||
      endpoint.hostname === "api.anthropic.com"
    )
      return undefined;

    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "").replace(/\/v1$/, "")}/v1/models`;
    endpoint.search = "";
    endpoint.hash = "";
    endpoint.searchParams.set("limit", "1000");

    const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
    if (env.ANTHROPIC_AUTH_TOKEN?.trim()) {
      headers.authorization = `Bearer ${env.ANTHROPIC_AUTH_TOKEN.trim()}`;
    } else {
      let key = env.ANTHROPIC_API_KEY?.trim();
      if (!key && apiKeyHelper?.trim()) {
        const platform = yield* HostProcess.Platform;
        const command =
          platform === "win32"
            ? ChildProcess.make(env.ComSpec || "cmd.exe", ["/d", "/s", "/c", apiKeyHelper], {
                env,
                ...(cwd ? { cwd } : {}),
              })
            : ChildProcess.make("sh", ["-c", apiKeyHelper], { env, ...(cwd ? { cwd } : {}) });
        const result = yield* spawnAndCollect("Claude API key helper", command);
        if (result.code !== 0) return undefined;
        key = result.stdout.trim();
      }
      if (key) headers["x-api-key"] = key;
    }

    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    const models = new Map<string, GatewayModel>();
    const cursors = new Set<string>();
    while (true) {
      const response = yield* client.execute(
        HttpClientRequest.get(endpoint.toString()).pipe(HttpClientRequest.setHeaders(headers)),
      );
      const page = yield* HttpClientResponse.schemaBodyJson(GatewayModels)(response);
      for (const model of page.data) {
        if (!model.id.trim()) return undefined;
        models.set(model.id, model);
      }
      if (!page.has_more) return [...models.values()];
      if (!page.last_id || cursors.has(page.last_id)) return undefined;
      cursors.add(page.last_id);
      endpoint.searchParams.set("after_id", page.last_id);
    }
  },
  Effect.timeout("5 seconds"),
  // Gateways without a models endpoint retain the ordinary Claude catalog.
  Effect.orElseSucceed(() => undefined),
);

export function applyClaudeGatewayModels(
  provider: ServerProviderDraft,
  models: ReadonlyArray<GatewayModel>,
): ServerProviderDraft {
  const known = new Map(provider.models.map((model) => [model.slug, model]));
  const unavailable = new Set(provider.updateRequiredModels?.map((model) => model.slug));
  const offered = new Set(models.map((model) => model.id));
  return {
    ...provider,
    models: models
      .filter((model) => !unavailable.has(model.id))
      .map(
        (model) =>
          known.get(model.id) ?? {
            slug: model.id,
            name: model.display_name || model.id,
            isCustom: true,
            capabilities: { optionDescriptors: [] },
          },
      ),
    ...(provider.updateRequiredModels
      ? {
          updateRequiredModels: provider.updateRequiredModels.filter((model) =>
            offered.has(model.slug),
          ),
        }
      : {}),
  };
}
