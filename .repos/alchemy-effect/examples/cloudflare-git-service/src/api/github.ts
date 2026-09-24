/** The compatibility endpoint delegates to the same application write operation. */
import * as Git from "alchemy/Git";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { AppApi } from "./api.ts";
import { mergePull } from "./ref-writes.ts";

const MergeBody = Schema.Struct({
  commit_message: Schema.optional(Schema.String),
  sha: Schema.optional(Schema.String),
  merge_method: Schema.optional(Schema.String),
});

export const GitHubLive = HttpApiBuilder.group(AppApi, "github", (h) =>
  Effect.gen(function* () {
    const defaults = yield* Git.Handlers;
    const git = yield* Git.Engine;
    const { mergePull: _, ...rest } = defaults.github;
    return h.handleAll(rest).handleRaw("mergePull", ({ request }) =>
      Effect.gen(function* () {
        const params = yield* HttpRouter.params;
        const number = Number(params.number);
        if (!Number.isSafeInteger(number) || number <= 0)
          return HttpServerResponse.empty({ status: 404 });
        const body = yield* request.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(MergeBody)),
        );
        if (body.merge_method !== undefined && body.merge_method !== "merge")
          return HttpServerResponse.jsonUnsafe(
            { message: "Merge method is not supported" },
            { status: 405 },
          );
        const result = yield* mergePull(
          git,
          { owner: params.owner ?? "", repo: params.repo ?? "", number },
          { message: body.commit_message, expectedHeadOid: body.sha },
        );
        return HttpServerResponse.jsonUnsafe({
          sha: result.oid,
          merged: true,
          message: "Pull Request successfully merged",
        });
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(
            HttpServerResponse.jsonUnsafe(
              { message: error._tag },
              {
                status:
                  error._tag === "PushDenied"
                    ? 403
                    : error._tag === "Unauthorized"
                      ? 401
                      : error._tag === "RepoNotFound" ||
                          error._tag === "PullNotFound"
                        ? 404
                        : error._tag === "SchemaError" ||
                            error._tag === "HttpServerError"
                          ? 400
                          : 409,
              },
            ),
          ),
        ),
      ),
    );
  }),
);
