import { TRAEX_CONSUMER_PATH } from "../inference/traex.ts";
import { TRAEX_BRIDGE_BASE_URL, type ServerProviderModel } from "@t3tools/contracts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { formatModelSlugName } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

const OptionalText = Schema.optionalKey(Schema.NullOr(Schema.String));
const TraexConfig = Schema.Struct({
  model_provider: Schema.Literal("traex"),
  model_providers: Schema.Struct({
    traex: Schema.Struct({
      base_url: Schema.NonEmptyString,
      env_key: OptionalText,
      auth: Schema.optionalKey(
        Schema.NullOr(
          Schema.Struct({
            command: Schema.String,
            args: Schema.optionalKey(Schema.Array(Schema.String)),
          }),
        ),
      ),
    }),
  }),
});

export const usesTraexLaunchArgs = (args: string) => {
  const provider = tokenizeCliArgs(args).findLast((arg) => /^model_provider\s*=/.test(arg));
  return provider !== undefined && /^model_provider\s*=\s*["']?traex["']?$/.test(provider);
};

const decodeTraexConfig = Schema.decodeUnknownOption(TraexConfig);

export function traexCatalogRoute(config: unknown) {
  const decoded = Option.getOrUndefined(decodeTraexConfig(config));
  if (!decoded) return undefined;
  const { base_url, env_key, auth } = decoded.model_providers.traex;
  const base = URL.parse(base_url);
  if (!base || !["http:", "https:"].includes(base.protocol)) return undefined;
  const localKey =
    base_url === TRAEX_BRIDGE_BASE_URL &&
    auth?.command === "sh" &&
    auth.args?.length === 2 &&
    auth.args[0] === "-c" &&
    auth.args[1] === "cat ~/.traex-bridge/api-key";
  base.pathname = base.pathname.replace(/\/$/, "") + "/models";
  return { url: base.href, envKey: env_key, localKey };
}

const ModelList = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({ id: Schema.NonEmptyString, name: OptionalText, display_name: OptionalText }),
  ),
});
const decodeModelList = Schema.decodeUnknownEffect(ModelList);

export const directTraexBridge = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const key = (yield* fs.readFileString(
    path.join(yield* HostProcess.HomeDirectory, ".traex-bridge", "api-key"),
  )).trim();
  return key ? { baseUrl: TRAEX_BRIDGE_BASE_URL, key } : undefined;
}).pipe(Effect.orElseSucceed(() => undefined));

export const readCodexEndpointModels = Effect.fn("CodexProvider.readEndpointModels")(
  function* (url: string, token: string | undefined) {
    const request = HttpClientRequest.get(url);
    const http = yield* HttpClient.HttpClient;
    const response = yield* http
      .execute(token ? HttpClientRequest.bearerToken(request, token) : request)
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
    const list = yield* response.json.pipe(Effect.flatMap(decodeModelList));
    return list.data.map(({ id, name, display_name }): ServerProviderModel => ({
      slug: id,
      name: display_name?.trim() || name?.trim() || formatModelSlugName(id),
      isCustom: false,
      capabilities: null,
    }));
  },
  Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
  (effect, url) => {
    // The local resolver also verifies a linked host and reads its bridge catalog.
    const target = new URL(url);
    return effect.pipe(
      Effect.timeout(
        target.hostname === "127.0.0.1" && target.pathname === TRAEX_CONSUMER_PATH + "/v1/models"
          ? "12 seconds"
          : "4 seconds",
      ),
    );
  },
);

export const readTraexModels = Effect.fn("CodexProvider.readTraexModels")(
  function* (
    route: ReturnType<typeof traexCatalogRoute>,
    environment: NodeJS.ProcessEnv,
    native: ReadonlyArray<ServerProviderModel>,
  ) {
    if (!route) return [];
    const token = route.localKey
      ? (yield* directTraexBridge)?.key
      : route.envKey
        ? environment[route.envKey]
        : undefined;
    if ((route.localKey || route.envKey) && !token) return [];
    const models = yield* readCodexEndpointModels(route.url, token);
    const bySlug = new Map(native.map((model) => [model.slug, model]));
    return models.map((model) => ({
      ...model,
      capabilities: bySlug.get(model.slug)?.capabilities ?? null,
    }));
  },
  Effect.orElseSucceed(() => []),
);
