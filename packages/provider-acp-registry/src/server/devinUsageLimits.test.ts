import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { readDevinUsageLimits } from "./devinUsageLimits.ts";

const CREDENTIALS_TOML = `windsurf_api_key = "stored-key"
api_server_url = "https://server.codeium.com"
devin_webapp_host = "app.devin.ai"
`;

const decodeRequestBody = Schema.decodeUnknownSync(
  Schema.Struct({ metadata: Schema.Struct({ apiKey: Schema.String }) }),
);

const requestApiKey = (request: HttpClientRequest.HttpClientRequest) =>
  request.body._tag === "Uint8Array"
    ? decodeRequestBody(JSON.parse(new TextDecoder().decode(request.body.body))).metadata.apiKey
    : undefined;

const quotaResponse = (planStatus: Record<string, unknown>) =>
  Response.json({ userStatus: { userId: "user-1", planStatus } });

interface CapturedRequest {
  readonly url: string;
  readonly apiKey: string | undefined;
  readonly redirect: RequestInit["redirect"];
}

const recordingClient = (captured: CapturedRequest[], response: Response) =>
  HttpClient.make((request, _url, _signal, fiber) =>
    Effect.sync(() => {
      captured.push({
        url: request.url,
        apiKey: requestApiKey(request),
        redirect: Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit)?.redirect,
      });
      return HttpClientResponse.fromWeb(request, response);
    }),
  );

const withCredentialsDir = Effect.fnUntraced(function* (toml: string | undefined) {
  const fs = yield* FileSystem.FileSystem;
  const dataHome = yield* fs.makeTempDirectoryScoped();
  if (toml !== undefined) {
    yield* fs.makeDirectory(`${dataHome}/devin`);
    yield* fs.writeFileString(`${dataHome}/devin/credentials.toml`, toml);
  }
  return dataHome;
});

const readLimits = (environment: NodeJS.ProcessEnv, client: HttpClient.HttpClient) =>
  readDevinUsageLimits({ environment }).pipe(Effect.provideService(HttpClient.HttpClient, client));

describe("readDevinUsageLimits", () => {
  it.effect.each([
    {
      name: "quota billing with hidden daily quota reports only the weekly window",
      planStatus: {
        planInfo: {
          billingStrategy: "BILLING_STRATEGY_QUOTA",
          hideDailyQuota: true,
          devinInfo: { webappHost: "app.devin.ai" },
        },
        dailyQuotaRemainingPercent: 100,
        weeklyQuotaRemainingPercent: 68,
        dailyQuotaResetAtUnix: "1793692800",
        weeklyQuotaResetAtUnix: 1794124800,
      },
      expectedWindows: [
        {
          id: "devin_weekly",
          kind: "weekly",
          label: "Devin · Weekly",
          windowDurationMins: 10080,
          usedPercent: 32,
          resetsAt: "2026-11-08T08:00:00.000Z",
        },
      ],
    },
    {
      name: "quota billing shows the daily window and treats a missing remaining percent as fully used",
      planStatus: {
        planInfo: {
          billingStrategy: "BILLING_STRATEGY_QUOTA",
          devinInfo: { webappHost: "app.devin.ai" },
        },
        weeklyQuotaRemainingPercent: 50,
        weeklyQuotaResetAtUnix: "1794124800",
      },
      expectedWindows: [
        {
          id: "devin_daily",
          kind: "session",
          label: "Devin · Daily",
          windowDurationMins: 1440,
          usedPercent: 100,
        },
        {
          id: "devin_weekly",
          kind: "weekly",
          label: "Devin · Weekly",
          windowDurationMins: 10080,
          usedPercent: 50,
          resetsAt: "2026-11-08T08:00:00.000Z",
        },
      ],
    },
    {
      name: "reports the daily window without a reset when its timestamp is out of range",
      planStatus: {
        planInfo: {
          billingStrategy: "BILLING_STRATEGY_QUOTA",
          devinInfo: { webappHost: "app.devin.ai" },
        },
        weeklyQuotaRemainingPercent: 50,
        dailyQuotaResetAtUnix: "99999999999999",
        weeklyQuotaResetAtUnix: "1794124800",
      },
      expectedWindows: [
        {
          id: "devin_daily",
          kind: "session",
          label: "Devin · Daily",
          windowDurationMins: 1440,
          usedPercent: 100,
        },
        {
          id: "devin_weekly",
          kind: "weekly",
          label: "Devin · Weekly",
          windowDurationMins: 10080,
          usedPercent: 50,
          resetsAt: "2026-11-08T08:00:00.000Z",
        },
      ],
    },
  ])("$name", ({ planStatus, expectedWindows }) =>
    Effect.gen(function* () {
      const dataHome = yield* withCredentialsDir(CREDENTIALS_TOML);
      const captured: CapturedRequest[] = [];
      const limits = yield* readLimits(
        { XDG_DATA_HOME: dataHome },
        recordingClient(captured, quotaResponse(planStatus)),
      );

      expect(limits.unavailable).toBeUndefined();
      expect(limits.windows).toEqual(expectedWindows);
      expect(limits.credentialFingerprint).toBe(
        "f9d39b225610aa5f5dc0a7beafb3633c502db2035acc4daf62cb93142782493c",
      );
      expect(limits).not.toHaveProperty("externalUsage");
      expect(captured).toHaveLength(1);
      expect(captured[0]?.url).toBe(
        "https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus",
      );
      expect(captured[0]?.apiKey).toBe("stored-key");
      expect(captured[0]?.redirect).toBe("error");
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect.each(["XDG_DATA_HOME", "APPDATA"])(
    "reports non-quota billing without a sign-in hint using %s",
    (directoryVariable) =>
      Effect.gen(function* () {
        const dataHome = yield* withCredentialsDir(CREDENTIALS_TOML);
        const captured: CapturedRequest[] = [];
        const limits = yield* readLimits(
          { [directoryVariable]: dataHome, USERPROFILE: dataHome },
          recordingClient(
            captured,
            quotaResponse({ planInfo: { billingStrategy: "BILLING_STRATEGY_CREDITS" } }),
          ),
        );

        expect(limits.unavailable).toEqual({ reason: "unsupported" });
        expect(limits.windows).toEqual([]);
        expect(captured).toHaveLength(1);
      }).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
  );

  it.effect("reports an auth rejection with the sign-in message", () =>
    Effect.gen(function* () {
      const dataHome = yield* withCredentialsDir(CREDENTIALS_TOML);
      const captured: CapturedRequest[] = [];
      const limits = yield* readLimits(
        { XDG_DATA_HOME: dataHome },
        recordingClient(captured, Response.json({}, { status: 401 })),
      );

      expect(limits.unavailable).toEqual({
        reason: "unsupported",
        message: "Sign in to Devin to see usage limits.",
      });
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("prefers WINDSURF_API_KEY and the default server URL over stored credentials", () =>
    Effect.gen(function* () {
      const dataHome = yield* withCredentialsDir(`windsurf_api_key = "stored-key"
api_server_url = "http://insecure.example"
`);
      const captured: CapturedRequest[] = [];
      const limits = yield* readLimits(
        { XDG_DATA_HOME: dataHome, WINDSURF_API_KEY: "  env-key  " },
        recordingClient(
          captured,
          quotaResponse({
            planInfo: { billingStrategy: "BILLING_STRATEGY_QUOTA", hideDailyQuota: true },
            weeklyQuotaRemainingPercent: 75,
          }),
        ),
      );

      expect(limits.unavailable).toBeUndefined();
      expect(captured).toHaveLength(1);
      expect(captured[0]?.url).toBe(
        "https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus",
      );
      expect(captured[0]?.apiKey).toBe("env-key");
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("reports unsupported without credentials and never calls the API", () =>
    Effect.gen(function* () {
      const dataHome = yield* withCredentialsDir(undefined);
      const limits = yield* readLimits(
        { XDG_DATA_HOME: dataHome },
        HttpClient.make(() => Effect.die("unexpected usage request")),
      );

      expect(limits.unavailable).toEqual({
        reason: "unsupported",
        message: "Sign in to Devin to see usage limits.",
      });
      expect(limits.windows).toEqual([]);
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
});
