import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest } from "effect/http";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";

import { isAzureDevOpsServicesUrl } from "./azureDevOpsPullRequestJson.ts";

/** Azure DevOps' application id, the resource every Entra token for it is issued to. */
const AZURE_DEVOPS_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";
const REST_API_VERSION = "7.1";
/** Renew a token this long before Entra says it expires. */
const TOKEN_RENEW_MARGIN_MS = 5 * 60_000;
/** How long `az` is left alone after it could not issue a token. */
const TOKEN_RETRY_MS = 5 * 60_000;
/** How long an organization that refused the token is read through `az` instead. */
const ORGANIZATION_RETRY_MS = 15 * 60_000;
const TOKEN_TIMEOUT_MS = 30_000;
/** Matches the `az` read deadline, so a stalled request falls back as a stalled process would. */
const REQUEST_TIMEOUT_MS = 30_000;

const AccessTokenJson = Schema.fromJsonString(
  Schema.Struct({
    accessToken: Schema.NonEmptyString,
    expires_on: Schema.optional(Schema.Union([Schema.Number, Schema.NumberFromString])),
  }),
);
const decodeAccessToken = Schema.decodeEffect(AccessTokenJson);

interface HeldToken {
  readonly token: string;
  readonly renewAt: number;
}

/**
 * Reads Azure DevOps REST resources over HTTP with the Entra token `az login` holds, so a read costs
 * one request instead of one `az` process. Every read answers `None` when that path is unavailable
 * (no token, an organization that refuses it, any failed response), and the caller reads through
 * `az` instead, which keeps its credential rules and its error reporting.
 */
export class AzureDevOpsRest extends Context.Service<
  AzureDevOpsRest,
  {
    readonly getJson: (input: {
      readonly cwd: string;
      /** An Azure DevOps Services URL, without `api-version`; any other URL answers `None`. */
      readonly url: string;
      readonly maxOutputBytes: number;
    }) => Effect.Effect<Option.Option<string>>;
  }
>()("@t3tools/source-control-azure-devops/server/AzureDevOpsRest") {}

/** Credentials are per organization: `dev.azure.com/{org}`, or the whole host anywhere else. */
function organizationKey(url: URL): string {
  const [first] = url.pathname.split("/").filter(Boolean);
  return url.hostname.toLowerCase() === "dev.azure.com" && first !== undefined
    ? `${url.origin}/${first.toLowerCase()}`
    : url.origin.toLowerCase();
}

const make = Effect.gen(function* () {
  const { process } = yield* SourceControlHost.SourceControlHost;
  const httpClient = yield* HttpClient.HttpClient;
  const tokenLock = yield* Semaphore.make(1);
  let held: HeldToken | null = null;
  let tokenRetryAt = 0;
  const refusedUntil = new Map<string, number>();

  const issueToken = Effect.fn("AzureDevOpsRest.issueToken")(function* (cwd: string) {
    return yield* process
      .run({
        operation: "AzureDevOpsRest.issueToken",
        command: "az",
        args: [
          "account",
          "get-access-token",
          "--resource",
          AZURE_DEVOPS_RESOURCE,
          "--only-show-errors",
          "--output",
          "json",
        ],
        cwd,
        timeoutMs: TOKEN_TIMEOUT_MS,
      })
      .pipe(
        Effect.flatMap((output) => decodeAccessToken(output.stdout.trim())),
        Effect.option,
      );
  });

  const token = Effect.fn("AzureDevOpsRest.token")(function* (cwd: string) {
    return yield* tokenLock.withPermit(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (held !== null && now < held.renewAt) return Option.some(held.token);
        if (now < tokenRetryAt) return Option.none<string>();
        const issued = yield* issueToken(cwd);
        if (Option.isNone(issued)) {
          held = null;
          tokenRetryAt = now + TOKEN_RETRY_MS;
          return Option.none<string>();
        }
        const expiresAt =
          issued.value.expires_on === undefined
            ? now + 30 * 60_000
            : issued.value.expires_on * 1000;
        held = { token: issued.value.accessToken, renewAt: expiresAt - TOKEN_RENEW_MARGIN_MS };
        return Option.some(held.token);
      }),
    );
  });

  const getJson: AzureDevOpsRest["Service"]["getJson"] = Effect.fn("AzureDevOpsRest.getJson")(
    function* (input) {
      const url = URL.parse(input.url);
      if (url === null || !isAzureDevOpsServicesUrl(url)) return Option.none();
      const organization = organizationKey(url);
      const now = yield* Clock.currentTimeMillis;
      if ((refusedUntil.get(organization) ?? 0) > now) return Option.none();

      const bearer = yield* token(input.cwd);
      if (Option.isNone(bearer)) return Option.none();

      url.searchParams.set("api-version", REST_API_VERSION);
      const request = HttpClientRequest.get(url.toString()).pipe(
        HttpClientRequest.bearerToken(bearer.value),
        HttpClientRequest.acceptJson,
      );
      return yield* httpClient.execute(request).pipe(
        Effect.flatMap((response) => {
          const json = (response.headers["content-type"] ?? "").includes("application/json");
          // A refused credential answers 401, or 203 with a sign-in page.
          if (
            response.status === 401 ||
            response.status === 403 ||
            (response.status < 300 && !json)
          ) {
            return Clock.currentTimeMillis.pipe(
              Effect.map((at) => {
                refusedUntil.set(organization, at + ORGANIZATION_RETRY_MS);
                return Option.none<string>();
              }),
            );
          }
          if (response.status < 200 || response.status >= 300) {
            return Effect.succeedNone;
          }
          return collectUint8StreamText({
            stream: response.stream,
            maxBytes: input.maxOutputBytes,
          }).pipe(
            Effect.map((body) =>
              body.truncated || body.invalidUtf8 ? Option.none<string>() : Option.some(body.text),
            ),
          );
        }),
        Effect.timeoutOrElse({ duration: REQUEST_TIMEOUT_MS, orElse: () => Effect.succeedNone }),
        Effect.orElseSucceed(() => Option.none<string>()),
      );
    },
  );

  return AzureDevOpsRest.of({ getJson });
});

export const layer = Layer.effect(AzureDevOpsRest, make);
