import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { SourceControlProviderContext } from "@t3tools/source-control-core/server/SourceControlProvider";

export class ForgejoTransportError extends Schema.TaggedError<ForgejoTransportError>()(
  "ForgejoTransportError",
  {
    operation: Schema.String,
    detail: Schema.String,
    status: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
import { ForgejoCli, type ForgejoCliError } from "./ForgejoCli.ts";

/** Shared transport for the fork's issue and review operations, using upstream's fj/gt login selection. */
export class ForgejoTransport extends Context.Service<
  ForgejoTransport,
  {
    readonly request: (input: {
      readonly operation: string;
      readonly method: "GET" | "POST" | "PATCH" | "DELETE";
      readonly host: string;
      readonly path: string;
      readonly cwd?: string;
      readonly body?: string;
      readonly accept?: string;
      readonly maxBytes?: number;
    }) => Effect.Effect<
      { readonly status: number; readonly body: string; readonly truncated: boolean },
      ForgejoTransportError
    >;
    readonly resolveLocator: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProviderContext;
    }) => Effect.Effect<
      {
        readonly host: string;
        readonly owner: string;
        readonly repo: string;
        readonly scheme: "http" | "https";
      },
      ForgejoTransportError
    >;
  }
>()("@t3tools/source-control-forgejo/server/ForgejoTransport") {}

const make = Effect.gen(function* () {
  const cli = yield* ForgejoCli;
  const failure = (operation: string) => (cause: ForgejoCliError) =>
    new ForgejoTransportError({
      operation,
      detail: cause.detail,
      ...(cause.httpStatus === undefined ? {} : { status: cause.httpStatus }),
      cause,
    });
  return ForgejoTransport.of({
    request: Effect.fn("ForgejoTransport.request")((input) =>
      cli
        .api({
          cwd: input.cwd ?? ".",
          host: input.host,
          path: input.path.replace(/^\//, ""),
          method: input.method,
          ...(input.body === undefined ? {} : { body: JSON.parse(input.body) }),
        })
        .pipe(
          Effect.mapError(failure(input.operation)),
          Effect.map((result) => ({
            status: 200,
            body:
              input.maxBytes === undefined ? result.stdout : result.stdout.slice(0, input.maxBytes),
            truncated:
              result.stdoutTruncated ||
              (input.maxBytes !== undefined && result.stdout.length > input.maxBytes),
          })),
        ),
    ),
    resolveLocator: Effect.fn("ForgejoTransport.resolveLocator")((input) =>
      cli.resolveRepository(input).pipe(
        Effect.mapError(failure("resolveLocator")),
        Effect.map((repo) => {
          const url = new URL(repo.baseUrl);
          const [owner = "", name = ""] = repo.repository.split("/");
          return {
            host: url.host,
            owner,
            repo: name,
            scheme: url.protocol === "http:" ? ("http" as const) : ("https" as const),
          };
        }),
      ),
    ),
  });
});

export const layer = Layer.effect(ForgejoTransport, make);
