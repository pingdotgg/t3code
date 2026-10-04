import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import * as NodeCrypto from "node:crypto";
import {
  TaskIntegrationError,
  TaskSource,
  TaskResult,
  type TaskConfigureInput,
  type TaskRequest,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import { runTaskProvider, taskEditableFields, type TaskTransport } from "./taskProviders.ts";

const StoredSource = Schema.Struct({ source: TaskSource, token: Schema.String });
const decodeStoredSource = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredSource));
const encodeStoredSource = Schema.encodeEffect(Schema.fromJsonString(StoredSource));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeTaskResult = Schema.decodeEffect(Schema.fromJsonString(TaskResult));
const encodeTaskResult = Schema.encodeEffect(Schema.fromJsonString(TaskResult));
const hash = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const unavailable = () =>
  new TaskIntegrationError({
    code: "unavailable",
    message: "The task integration is unavailable. Local drafts have been preserved.",
  });
const invalid = (message: string) => new TaskIntegrationError({ code: "invalid", message });

export class TaskService extends Context.Service<
  TaskService,
  {
    readonly configure: (input: TaskConfigureInput) => Effect.Effect<void, TaskIntegrationError>;
    readonly execute: (input: TaskRequest) => Effect.Effect<TaskResult, TaskIntegrationError>;
  }
>()("t3/tasks/TaskService") {}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const projects = yield* ProjectService.ProjectService;
  const github = yield* GitHubCli.GitHubCli;
  const sql = yield* SqlClient.SqlClient;
  const http = yield* HttpClient.HttpClient;
  const key = (projectId: string) => `task-source-${hash(projectId)}`;
  const read = (projectId: string) =>
    secrets.get(key(projectId)).pipe(
      Effect.flatMap((value) =>
        Option.isNone(value)
          ? Effect.succeed(null)
          : decodeStoredSource(new TextDecoder().decode(value.value)),
      ),
      Effect.mapError(unavailable),
    );
  const configure = Effect.fn("TaskService.configure")(function* (input: TaskConfigureInput) {
    const project = yield* projects.getById(input.projectId).pipe(Effect.mapError(unavailable));
    if (Option.isNone(project)) return yield* invalid("Select an existing project.");
    if (!input.source)
      return yield* secrets.remove(key(input.projectId)).pipe(Effect.mapError(unavailable));
    const source = input.source;
    const origin = yield* Effect.try({
      try: () => new URL(source.baseUrl),
      catch: () => invalid("Enter a valid HTTPS task-source URL."),
    });
    if (
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      origin.pathname !== "/"
    ) {
      return yield* invalid("Use an HTTPS origin without a path, query, or credentials.");
    }
    if (!source.scope.trim()) return yield* invalid("A repository or Linear team ID is required.");
    if (source.provider === "linear" && origin.origin !== "https://linear.app")
      return yield* invalid("Linear uses https://linear.app.");
    if (source.provider === "github" && !/^[\w.-]+\/[\w.-]+$/.test(source.scope))
      return yield* invalid("GitHub scope must be owner/repository.");
    const previous = yield* read(input.projectId);
    const sameAccount =
      previous?.source.provider === source.provider && previous.source.baseUrl === origin.origin;
    const token = input.token ? Redacted.value(input.token) : sameAccount ? previous.token : "";
    if (source.provider === "linear" && !token)
      return yield* invalid("This task source requires an API token.");
    const value = { source: { ...source, baseUrl: origin.origin }, token };
    yield* secrets
      .set(
        key(input.projectId),
        new TextEncoder().encode(
          yield* encodeStoredSource(value).pipe(Effect.mapError(unavailable)),
        ),
      )
      .pipe(Effect.mapError(unavailable));
  });
  const execute = Effect.fn("TaskService.execute")(function* (input: TaskRequest) {
    const project = yield* projects.getById(input.projectId).pipe(Effect.mapError(unavailable));
    if (Option.isNone(project)) return yield* invalid("This project is no longer available.");
    const stored = yield* read(input.projectId);
    const result: TaskResult = {
      source: stored?.source ?? null,
      tasks: [],
      nextCursor: null,
      editableFields: stored ? taskEditableFields(stored.source.provider) : [],
      canComment: !!stored,
      links: [],
    };
    if (input.action === "status") return result;
    if (input.action === "link") {
      const link = input.link;
      if (
        !link ||
        link.projectId !== input.projectId ||
        !stored ||
        link.provider !== stored.source.provider ||
        !link.taskUrl.startsWith(`${stored.source.baseUrl}/`)
      )
        return yield* invalid("Invalid task link.");
      const links = yield* sql<
        TaskResult["links"][number]
      >`INSERT INTO external_task_links (project_id, thread_id, task_url, task_key, title, provider)
        VALUES (${link.projectId}, ${link.threadId}, ${link.taskUrl}, ${link.taskKey}, ${link.title}, ${link.provider})
        ON CONFLICT(project_id, task_url) DO UPDATE SET title = excluded.title
        RETURNING project_id AS "projectId", thread_id AS "threadId", task_url AS "taskUrl", task_key AS "taskKey", title, provider`.pipe(
        Effect.mapError(unavailable),
      );
      return { ...result, links };
    }
    if (input.action === "unlink") {
      yield* sql`DELETE FROM external_task_links WHERE project_id = ${input.projectId} AND thread_id = ${input.threadId ?? ""} AND task_url = ${input.id ?? ""}`.pipe(
        Effect.mapError(unavailable),
      );
      return result;
    }
    if (input.action === "links") {
      const links = yield* sql<{
        projectId: typeof input.projectId;
        threadId: NonNullable<TaskRequest["threadId"]>;
        provider: TaskSource["provider"];
        taskUrl: string;
        taskKey: string;
        title: string;
      }>`SELECT project_id AS "projectId", thread_id AS "threadId", task_url AS "taskUrl", task_key AS "taskKey", title, provider
          FROM external_task_links WHERE project_id = ${input.projectId}
          AND (${input.threadId ?? ""} = '' OR thread_id = ${input.threadId ?? ""}) LIMIT 500`.pipe(
        Effect.mapError(unavailable),
      );
      return { ...result, links };
    }
    if (!stored) return yield* invalid("Connect a task source for this project first.");
    const { source, token } = stored;
    const request: TaskTransport = Effect.fn("TaskService.request")(function* (
      path,
      body,
      method = body === undefined ? "GET" : "POST",
    ) {
      if (source.provider === "github") {
        const response = yield* github
          .execute({
            cwd: project.value.workspaceRoot,
            args: [
              "api",
              "--hostname",
              new URL(source.baseUrl).host,
              "--method",
              method,
              path,
              ...(body === undefined ? [] : ["--input", "-"]),
            ],
            ...(body === undefined
              ? {}
              : {
                  stdin: yield* encodeJson(body).pipe(Effect.mapError(unavailable)),
                }),
            maxOutputBytes: 2 * 1024 * 1024,
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new TaskIntegrationError({
                  code: error._tag.includes("Authentication")
                    ? "authentication"
                    : error._tag.includes("RateLimit")
                      ? "rate-limit"
                      : "unavailable",
                  message:
                    error._tag === "GitHubCliUnavailableError"
                      ? "Install GitHub CLI (gh) in the selected environment, sign in, and retry."
                      : error._tag === "GitHubCliCommandError" &&
                          (error.httpStatus === 403 || error.httpStatus === 404)
                        ? "The issue is unavailable to this GitHub account. Check the repository, issue, and account permissions."
                        : error._tag.includes("Authentication")
                          ? "Reconnect gh in this environment."
                          : error._tag.includes("RateLimit")
                            ? "The provider rate limit was reached. Wait before refreshing."
                            : "The task provider request failed.",
                }),
            ),
          );
        return response.stdout.trim()
          ? yield* decodeJson(response.stdout).pipe(Effect.mapError(unavailable))
          : null;
      }
      const response = yield* http
        .execute(
          HttpClientRequest.post("https://api.linear.app/graphql").pipe(
            HttpClientRequest.setHeader("authorization", token),
            HttpClientRequest.acceptJson,
            HttpClientRequest.bodyText(
              yield* encodeJson(body).pipe(Effect.mapError(unavailable)),
              "application/json",
            ),
          ),
        )
        .pipe(Effect.timeout("30 seconds"), Effect.mapError(unavailable));
      if (response.status < 200 || response.status >= 300)
        return yield* new TaskIntegrationError({
          code:
            response.status === 401 || response.status === 403
              ? "authentication"
              : response.status === 429
                ? "rate-limit"
                : "unavailable",
          message:
            response.status === 401 || response.status === 403
              ? "Reconnect Linear or check its permissions."
              : response.status === 429
                ? "Linear's rate limit was reached. Wait before refreshing."
                : "Linear rejected the request.",
        });
      const bodyText = yield* collectUint8StreamText({
        stream: response.stream,
        maxBytes: 2 * 1024 * 1024,
      }).pipe(Effect.timeout("30 seconds"), Effect.mapError(unavailable));
      if (bodyText.truncated || bodyText.invalidUtf8) return yield* unavailable();
      return yield* decodeJson(bodyText.text).pipe(Effect.mapError(unavailable));
    });
    const write =
      input.action === "create" || input.action === "update" || input.action === "comment";
    if (write) {
      if (input.action === "create" && !input.changes?.title?.trim())
        return yield* invalid("A title is required.");
      if (!input.operationId || input.operationId.length > 128)
        return yield* invalid("An external write requires an operation ID.");
      if (input.action === "comment" && !input.comment?.trim())
        return yield* invalid("Write a comment first.");
      const fingerprint = hash(
        yield* encodeJson([
          source,
          input.projectId,
          input.action,
          input.id ?? null,
          input.changes ?? null,
          input.comment ?? null,
        ]).pipe(Effect.mapError(unavailable)),
      );
      const inserted = yield* sql`INSERT INTO external_task_writes(operation_id, fingerprint, state)
        VALUES (${input.operationId}, ${fingerprint}, 'uncertain') ON CONFLICT DO NOTHING RETURNING operation_id`.pipe(
        Effect.mapError(unavailable),
      );
      if (!inserted.length) {
        const existing = yield* sql<{
          fingerprint: string;
          state: string;
          result_json: string | null;
        }>`SELECT fingerprint, state, result_json FROM external_task_writes WHERE operation_id = ${input.operationId}`.pipe(
          Effect.mapError(unavailable),
        );
        if (existing[0]?.fingerprint !== fingerprint)
          return yield* invalid("This operation ID belongs to another change.");
        if (existing[0]?.state === "confirmed" && existing[0].result_json)
          return yield* decodeTaskResult(existing[0].result_json).pipe(
            Effect.mapError(unavailable),
          );
        return yield* new TaskIntegrationError({
          code: "uncertain-write",
          message:
            "The previous write may have succeeded. Check the source task before making another change; this operation will not be resent.",
        });
      }
    }
    const page = yield* runTaskProvider(source, input, request);
    if (write)
      yield* sql`UPDATE external_task_writes SET state = 'confirmed', result_json = ${yield* encodeTaskResult({ ...result, ...page }).pipe(Effect.mapError(unavailable))} WHERE operation_id = ${input.operationId!}`.pipe(
        Effect.mapError(unavailable),
      );
    return { ...result, ...page };
  });
  return TaskService.of({ configure, execute });
});
export const layer = Layer.effect(TaskService, make);
