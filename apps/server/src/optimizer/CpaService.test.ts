import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { SessionOptimizerAttachments } from "@t3tools/provider-core/server/sessionOptimizerAttachments";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

import * as ProcessRunner from "../processRunner.ts";
import { claudeResetCreditsToContract } from "../provider/claudeResetCredits.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CpaService from "./CpaService.ts";
import { OptimizerProbeService } from "./OptimizerProbeService.ts";

const CPA_URL = "http://127.0.0.1:8317";
const grant = (id: string, overrides: Record<string, unknown>) => ({
  id,
  resets_total: 1,
  resets_left: 1,
  starts_at: "2026-11-09T18:00:00+00:00",
  ends_at: "2027-03-09T07:59:00+00:00",
  clears: ["seven_day_overage_included"],
  paused: false,
  usable_now: true,
  type: "full",
  gives_back_weekly: true,
  ...overrides,
});
// Recorded from a live CPA api-call to the usage endpoint.
const cedarEmber = {
  eligible: true,
  next_grant_id: "full-reset-2611",
  grants: [
    grant("full-reset-2611", {
      label: "One full limit reset (November 2026)",
      starts_at: "2026-11-10T21:30:00+00:00",
      ends_at: "2026-12-10T22:00:00+00:00",
      clears: ["seven_day", "seven_day_overage_included"],
      type: "weekly",
      gives_back_weekly: false,
    }),
    grant("launch-2610-fable", {
      label: "New model launch: one Fable reset for Max, Team Premium and Enterprise Premium",
    }),
  ],
};

const ApiCall = Schema.Struct({
  auth_index: Schema.String,
  method: Schema.String,
  url: Schema.String,
  header: Schema.Record(Schema.String, Schema.String),
  data: Schema.optional(Schema.String),
});
const decodeApiCall = Schema.decodeUnknownSync(Schema.fromJsonString(ApiCall));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const claudeProvider: ServerProvider = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "2.1.327",
  status: "ready",
  auth: { status: "authenticated", type: "customEndpoint", endpoint: CPA_URL },
  checkedAt: "2026-11-18T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

/** A CLIProxyAPI with one Claude account that answers usage reads and reset claims. */
const fakeCpa = () => {
  const upstream: Array<typeof ApiCall.Type> = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const path = new URL(request.url).pathname;
      if (path === "/v0/management/auth-files") {
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ files: [{ id: "claude.json", auth_index: "c", provider: "claude" }] }),
        );
      }
      expect(path).toBe("/v0/management/api-call");
      const call = decodeApiCall(
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
      );
      upstream.push(call);
      const body = call.url.endsWith("/reset_rate_limits")
        ? { result: "reset" }
        : {
            five_hour: { utilization: 10, resets_at: null },
            seven_day: { utilization: 76, resets_at: "2026-11-22T09:59:59Z" },
            cedar_ember: cedarEmber,
          };
      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          status_code: 200,
          header: { "Anthropic-Organization-Id": ["org-cpa"] },
          body: encodeJson(body),
        }),
      );
    }),
  );
  return { client, upstream };
};

const withCpa = <A, E>(
  client: HttpClient.HttpClient,
  use: (cpa: CpaService.CpaService["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const managementKeyPath = path.join(yield* fs.makeTempDirectoryScoped(), "management-key");
    yield* fs.writeFileString(managementKeyPath, "management-secret\n");
    return yield* CpaService.CpaService.pipe(
      Effect.flatMap(use),
      Effect.provide(
        CpaService.layer.pipe(
          Layer.provide(ServerSettings.layerTest({ cpa: { url: CPA_URL, managementKeyPath } })),
          Layer.provide(Layer.mock(SessionOptimizerAttachments)({})),
          Layer.provide(Layer.mock(OptimizerProbeService)({})),
          Layer.provide(Layer.mock(ProcessRunner.ProcessRunner)({})),
          Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
          Layer.provide(NodeCrypto.layer),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("CpaService Claude reset credits", () => {
  it.effect("reads the CPA account's grants into the same contract as the native read", () =>
    withCpa(fakeCpa().client, (cpa) =>
      Effect.gen(function* () {
        const overlaid = yield* cpa.overlayUsageLimits(claudeProvider);
        expect(overlaid.usageLimits?.resetCredits).toEqual(
          claudeResetCreditsToContract(cedarEmber, 0),
        );
        expect(overlaid.usageLimits?.resetCredits).toMatchObject({
          availableCount: 2,
          nextCreditId: "full-reset-2611",
        });
      }),
    ),
  );

  it.effect("redeems through CPA for the organization its usage read reported", () => {
    const cpa = fakeCpa();
    return withCpa(cpa.client, (service) =>
      Effect.gen(function* () {
        const route = yield* service.claudeResetCredits(claudeProvider);
        if (Option.isNone(route)) return expect.unreachable("CPA route missing");
        expect(yield* route.value.redeem({ grantId: "full-reset-2611", requestId: "r-1" })).toBe(
          "reset",
        );
        const claim = cpa.upstream.at(-1);
        expect(claim).toMatchObject({
          auth_index: "c",
          method: "POST",
          url: "https://api.anthropic.com/api/organizations/org-cpa/reset_rate_limits",
          header: {
            authorization: "Bearer $TOKEN$",
            "user-agent": "claude-cli/2.1.327 (external, cli)",
          },
        });
        expect(decodeJson(claim?.data)).toEqual({
          program: "cedar_ember",
          grant_id: "full-reset-2611",
          request_id: "r-1",
        });
      }),
    );
  });

  it.effect("falls back to the native credits when CPA is unreachable", () =>
    withCpa(
      HttpClient.make((request) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request }),
          }),
        ),
      ),
      (cpa) =>
        Effect.gen(function* () {
          expect(yield* cpa.overlayUsageLimits(claudeProvider)).toBe(claudeProvider);
          expect(Option.isNone(yield* cpa.claudeResetCredits(claudeProvider))).toBe(true);
        }),
    ),
  );
});
