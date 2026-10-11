import {
  ProviderDriverKind,
  type ProviderCloudConfiguration,
  type ProviderCloudEnvironmentMutation,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

const isDriverError = Schema.is(ProviderDriverError);
const Auth = Schema.Struct({
  tokens: Schema.Struct({
    access_token: Schema.NonEmptyString,
    account_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
});
const Repository = Schema.Struct({
  id: Schema.NonEmptyString,
  repository_full_name: Schema.NonEmptyString,
  default_branch: Schema.NonEmptyString,
});
const Repositories = Schema.Struct({ repositories: Schema.Array(Repository) });
const ConfigRepository = Schema.Struct({
  repository_id: Schema.NonEmptyString,
  ref: Schema.NonEmptyString,
});
const Config = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  status: Schema.NonEmptyString,
  version_id: Schema.NonEmptyString,
  version_revision: Schema.optionalKey(Schema.Number),
  thread_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  repositories: Schema.Array(ConfigRepository),
  install_script: Schema.optionalKey(Schema.String),
  start_skill: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  draft: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        id: Schema.NonEmptyString,
        revision: Schema.Number,
        repositories: Schema.Array(ConfigRepository),
        install_script: Schema.optionalKey(Schema.String),
        start_skill: Schema.optionalKey(Schema.String),
        cwd: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
});
const ConfigList = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.NonEmptyString,
      name: Schema.NonEmptyString,
      version_revision: Schema.optionalKey(Schema.Number),
      repositories: Schema.Array(ConfigRepository),
    }),
  ),
  next_cursor: Schema.NullOr(Schema.String),
});
const Operation = Schema.Struct({
  id: Schema.NonEmptyString,
  kind: Schema.Literal("APPROVE_ENVIRONMENT_CONFIG_DRAFT"),
  state: Schema.Literals(["PENDING", "RUNNING", "SUCCEEDED", "FAILED"]),
});

/** Keeps CLI credentials on the host and implements the ChatGPT cloud configuration protocol. */
export const makeCodexCloud = Effect.fn("makeCodexCloud")(function* (
  instanceId: ProviderInstanceId,
  homePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const error = (detail: string) =>
    new ProviderDriverError({ driver: ProviderDriverKind.make("codex"), instanceId, detail });
  const readAuth = () =>
    fs.readFileString(path.join(homePath, "auth.json")).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Auth))),
      Effect.map((auth) => auth.tokens),
      Effect.mapError(() => error("Sign in to Codex with ChatGPT to use cloud environments.")),
    );
  const request = (route: string, method: "GET" | "POST" | "DELETE" = "GET", body?: unknown) =>
    Effect.gen(function* () {
      const auth = yield* readAuth();
      let req = HttpClientRequest.make(method)(
        route.startsWith("/wham/")
          ? `https://chatgpt.com/backend-api${route}`
          : `https://codex-cloud-backend.chatgpt.com${route}`,
      ).pipe(
        HttpClientRequest.bearerToken(auth.access_token),
        HttpClientRequest.setHeader("X-OpenAI-Product-Sku", "codex"),
        HttpClientRequest.setHeader("User-Agent", "t3code"),
      );
      if (auth.account_id)
        req = req.pipe(HttpClientRequest.setHeader("ChatGPT-Account-Id", auth.account_id));
      if (body !== undefined)
        req = yield* HttpClientRequest.bodyJson(req, body).pipe(
          Effect.mapError(() => error("Invalid cloud environment request.")),
        );
      const response = yield* http
        .execute(req)
        .pipe(
          Effect.mapError(() => error("Could not reach Codex Cloud. Refresh before trying again.")),
        );
      if (response.status === 401 || response.status === 403)
        return yield* error("Check your Codex sign-in and cloud permissions, then try again.");
      if (response.status === 409)
        return yield* error(
          "The environment changed. Refresh its configuration before trying again.",
        );
      if (response.status < 200 || response.status >= 300)
        return yield* error(
          "Codex Cloud could not complete this request. Refresh before trying again.",
        );
      if (method === "DELETE") return null;
      return yield* response.json.pipe(
        Effect.mapError(() => error("Codex Cloud returned an unreadable response.")),
      );
    }).pipe(
      Effect.timeout("20 seconds"),
      Effect.catchTags({
        TimeoutError: () =>
          error(
            "Codex Cloud did not respond. Refresh before trying again; the request may have completed.",
          ),
      }),
      Effect.scoped,
    );
  const decodeConfig = Schema.decodeUnknownEffect(Config);
  const toConfiguration = (config: typeof Config.Type): ProviderCloudConfiguration => {
    const current = config.draft ?? config;
    return {
      id: config.id,
      name: config.name,
      status: config.status,
      versionId: config.version_id,
      published: (config.version_revision ?? 1) > 1,
      threadId: config.thread_id ?? null,
      draftId: config.draft?.id ?? null,
      revision: config.draft?.revision ?? null,
      repositories: current.repositories.map((repo) => ({ id: repo.repository_id, ref: repo.ref })),
      installScript: current.install_script ?? "",
      startSkill: current.start_skill ?? "",
      cwd: current.cwd ?? "/workspace",
    };
  };
  const configRoute = (id: string) => `/v1/environment-configs/${encodeURIComponent(id)}`;
  const read = (id: string) =>
    request(configRoute(id)).pipe(
      Effect.flatMap(decodeConfig),
      Effect.map(toConfiguration),
      Effect.mapError((cause) =>
        isDriverError(cause) ? cause : error("Codex Cloud returned an unreadable environment."),
      ),
    );
  const listRepositories = (query = "") =>
    request(
      query.trim()
        ? `/wham/github/repositories/search/all-installations?query=${encodeURIComponent(query.trim())}&limit=100&page=1`
        : "/wham/github/list-repositories?page=1&per_page=100",
    ).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Repositories)),
      Effect.map((result) =>
        result.repositories.map((repo) => ({
          id: repo.id,
          name: repo.repository_full_name,
          defaultBranch: repo.default_branch,
        })),
      ),
      Effect.mapError((cause) =>
        isDriverError(cause) ? cause : error("Could not read connected GitHub repositories."),
      ),
    );
  const list = () =>
    Effect.gen(function* () {
      const environments = new Map<string, { id: string; label: string; setup: boolean }>();
      for (const scope of ["user", "workspace"]) {
        let cursor: string | null = null;
        for (let page = 0; page < 20; page++) {
          const result: typeof ConfigList.Type = yield* request(
            `/v1/environment-configs?scope=${scope}&limit=100&omitDraft=false${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          ).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(ConfigList)),
            Effect.mapError((cause) =>
              isDriverError(cause) ? cause : error("Could not read Codex Cloud environments."),
            ),
          );
          for (const config of result.data)
            environments.set(config.id, {
              id: config.id,
              label: config.name,
              setup: (config.version_revision ?? 1) <= 1,
            });
          cursor = result.next_cursor;
          if (!cursor) break;
        }
      }
      return [...environments.values()].sort((a, b) => a.label.localeCompare(b.label));
    });
  const mutate = (
    input: ProviderCloudEnvironmentMutation,
  ): Effect.Effect<ProviderCloudConfiguration | null, ProviderDriverError> =>
    Effect.gen(function* () {
      if (input.operation === "delete") {
        yield* request(configRoute(input.id), "DELETE");
        return null;
      }
      if (input.operation === "create") {
        // Resolve refs and access on the host; a client cannot invent a repository binding.
        const repositories = yield* Effect.forEach([...new Set(input.repositoryIds)], (id) =>
          request(`/wham/github/repositories/${encodeURIComponent(id)}`).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Repository)),
            Effect.mapError((cause) =>
              isDriverError(cause)
                ? cause
                : error("A selected repository is unavailable to this Codex account."),
            ),
          ),
        );
        const config = yield* request("/v1/environment-configs", "POST", {
          name: input.name,
          repositories: repositories.map((repo) => ({
            repository_id: repo.id,
            ref: repo.default_branch,
          })),
          network_policy:
            input.network === "package_managers"
              ? { type: "restricted", presets: ["package_managers"] }
              : { type: input.network },
          share_settings: "private",
          start_onboarding: false,
        }).pipe(
          Effect.flatMap(decodeConfig),
          Effect.mapError((cause) =>
            isDriverError(cause)
              ? cause
              : error("The environment may have been created. Refresh before trying again."),
          ),
        );
        return toConfiguration(config);
      }
      const config = yield* read(input.id);
      if (!config.draftId || config.revision === null)
        return yield* error("Complete the setup conversation, then refresh before publishing.");
      const route = `${configRoute(config.id)}/drafts/${encodeURIComponent(config.draftId)}/approve`;
      const operation = yield* request(`${route}/begin`, "POST", {
        expected_revision: config.revision,
        idempotency_key: yield* crypto.randomUUIDv4.pipe(
          Effect.mapError(() => error("Could not start the publishing operation.")),
        ),
      }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Operation)),
        Effect.mapError(() => error("Could not start publishing. Refresh before trying again.")),
      );
      let state = operation.state;
      while (state === "PENDING" || state === "RUNNING") {
        yield* Effect.sleep("2 seconds");
        const next = yield* request(
          `/v1/environment-operations/${encodeURIComponent(operation.id)}`,
        ).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Operation)),
          Effect.mapError(() => error("Publishing is still running. Refresh to check its result.")),
        );
        if (next.id !== operation.id)
          return yield* error("Could not verify the publishing operation.");
        state = next.state;
      }
      if (state === "FAILED")
        return yield* error(
          "Codex could not publish this environment. Review its setup and try again.",
        );
      const published = yield* request(`${route}/complete`, "POST", {
        operation_id: operation.id,
        ...(config.threadId ? { thread_id: config.threadId } : {}),
      }).pipe(
        Effect.flatMap(decodeConfig),
        Effect.mapError(() => error("Publishing may have completed. Refresh to check its result.")),
      );
      return toConfiguration(published);
    }).pipe(
      Effect.timeout("10 minutes"),
      Effect.catchTags({
        TimeoutError: () => error("Publishing is still running. Refresh to check its result."),
      }),
    );
  return { readAuth, list, listRepositories, read, mutate };
});
