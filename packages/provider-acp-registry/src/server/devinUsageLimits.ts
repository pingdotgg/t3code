import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Hex from "effect/encoding/Hex";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as HostProcess from "@t3tools/shared/HostProcess";

const DEFAULT_API_SERVER_URL = "https://server.codeium.com";
const USER_STATUS_PATH = "/exa.seat_management_pb.SeatManagementService/GetUserStatus";

/** The API key in the request body must never follow a redirect off the API server. */
const NO_REDIRECT: RequestInit = { redirect: "error" };

const tomlString = (contents: string, key: string): string | undefined =>
  new RegExp(`^\\s*${key}\\s*=\\s*"([^"\\n]*)"`, "m").exec(contents)?.[1];

// proto3 JSON omits zero values; int64 fields may arrive as strings.
const UnixSeconds = Schema.Union([Schema.Finite, Schema.String]);
const GetUserStatusResponse = Schema.Struct({
  userStatus: Schema.optionalKey(
    Schema.Struct({
      userId: Schema.optionalKey(Schema.String),
      planStatus: Schema.optionalKey(
        Schema.Struct({
          planInfo: Schema.optionalKey(
            Schema.Struct({
              billingStrategy: Schema.optionalKey(Schema.String),
              hideDailyQuota: Schema.optionalKey(Schema.Boolean),
            }),
          ),
          dailyQuotaRemainingPercent: Schema.optionalKey(Schema.Finite),
          weeklyQuotaRemainingPercent: Schema.optionalKey(Schema.Finite),
          dailyQuotaResetAtUnix: Schema.optionalKey(UnixSeconds),
          weeklyQuotaResetAtUnix: Schema.optionalKey(UnixSeconds),
        }),
      ),
    }),
  ),
});

const resetAtIso = (value: number | string | undefined): string | undefined => {
  const seconds = typeof value === "string" ? Number(value) : value;
  return seconds !== undefined && Number.isFinite(seconds) && seconds > 0
    ? Option.getOrUndefined(Option.map(DateTime.make(seconds * 1000), DateTime.formatIso))
    : undefined;
};

/** ACP exposes no quota data; Devin reads it from Codeium's seat-management API. */
export const readDevinUsageLimits = Effect.fn("readDevinUsageLimits")(function* (input: {
  readonly environment: NodeJS.ProcessEnv;
}) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const unsupported = makeUnavailableUsageLimits({
    checkedAt,
    reason: "unsupported",
    message: "Sign in to Devin to see usage limits.",
  });

  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const env = input.environment;
    const platform = yield* HostProcess.Platform;
    const dataHome =
      env.XDG_DATA_HOME ||
      (platform === "win32" ? env.APPDATA : undefined) ||
      path.join(
        env.HOME || env.USERPROFILE || (yield* HostProcess.HomeDirectory),
        ".local",
        "share",
      );
    const credentialsToml = yield* fs
      .readFileString(path.join(dataHome, "devin", "credentials.toml"))
      .pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(error),
        }),
      );

    // Devin's ACP server prefers WINDSURF_API_KEY over stored credentials.
    const envKey = env.WINDSURF_API_KEY?.trim();
    const apiKey = envKey || tomlString(credentialsToml, "windsurf_api_key")?.trim();
    if (!apiKey) return unsupported;
    const apiServerUrl = envKey
      ? DEFAULT_API_SERVER_URL
      : tomlString(credentialsToml, "api_server_url")?.trim() || DEFAULT_API_SERVER_URL;
    const apiUrl = URL.parse(apiServerUrl);
    if (!apiUrl || apiUrl.protocol !== "https:") return unsupported;

    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(
        HttpClientRequest.post(`${apiUrl.origin}${USER_STATUS_PATH}`).pipe(
          HttpClientRequest.setHeaders({
            "content-type": "application/json",
            "connect-protocol-version": "1",
          }),
          HttpClientRequest.bodyJsonUnsafe({
            metadata: {
              apiKey,
              ideName: "t3code",
              ideVersion: "0.0.0",
              extensionName: "t3code",
              extensionVersion: "0.0.0",
              locale: "en",
            },
          }),
        ),
      )
      .pipe(Effect.provideService(FetchHttpClient.RequestInit, NO_REDIRECT));
    if (response.status === 401 || response.status === 403) return unsupported;
    const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(GetUserStatusResponse)),
    );

    const planStatus = body.userStatus?.planStatus;
    if (planStatus?.planInfo?.billingStrategy !== "BILLING_STRATEGY_QUOTA") {
      return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
    }
    // A missing remaining percent means 0 remaining under proto3 JSON.
    const weeklyResetsAt = resetAtIso(planStatus.weeklyQuotaResetAtUnix);
    const windows: ServerProviderUsageWindow[] = [
      {
        id: "devin_weekly",
        kind: "weekly",
        label: "Devin · Weekly",
        windowDurationMins: 7 * 24 * 60,
        usedPercent: clampPercent(100 - (planStatus.weeklyQuotaRemainingPercent ?? 0)),
        ...(weeklyResetsAt ? { resetsAt: weeklyResetsAt } : {}),
      },
    ];
    if (planStatus.planInfo?.hideDailyQuota !== true) {
      const dailyResetsAt = resetAtIso(planStatus.dailyQuotaResetAtUnix);
      windows.push({
        id: "devin_daily",
        kind: "session",
        label: "Devin · Daily",
        windowDurationMins: 24 * 60,
        usedPercent: clampPercent(100 - (planStatus.dailyQuotaRemainingPercent ?? 0)),
        ...(dailyResetsAt ? { resetsAt: dailyResetsAt } : {}),
      });
    }

    const digest = yield* Digest.Digest;
    const userId = body.userStatus?.userId;
    // Unkeyed hashes match across environments; random API keys resist offline guessing.
    const credentialFingerprint = yield* digest
      .digest(
        Digest.sha256,
        new TextEncoder().encode(userId ? `devin-account\0${userId}` : `devin\0${apiKey}`),
      )
      .pipe(Effect.map(Hex.encode), Effect.orDie);
    return {
      ...makeUsageLimits({ checkedAt, windows }),
      credentialFingerprint,
    };
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.orElseSucceed(() =>
      makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Could not read Devin usage limits.",
      }),
    ),
  );
});
