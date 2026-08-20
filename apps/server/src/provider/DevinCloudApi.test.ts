import { expect, it } from "@effect/vitest";
import { DevinCloudSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { makeDevinCloudApi } from "./DevinCloudApi.ts";

const settings = Schema.decodeSync(DevinCloudSettings)({
  apiKey: "cog_test",
  organizationId: "org-test",
  createAsUserId: "user-test",
  repositories: "https://github.com/pingdotgg/t3code",
  tags: "t3-code",
});

it.effect("creates and continues the same Devin organization session", () =>
  Effect.gen(function* () {
    const requests: HttpClientRequest.HttpClientRequest[] = [];
    const client = HttpClient.make((request) => {
      requests.push(request);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            session_id: "devin-session",
            status: "running",
            url: "https://app.devin.ai/sessions/devin-session",
          }),
        ),
      );
    });
    const api = yield* makeDevinCloudApi(settings).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
    );

    yield* api.createSession({
      prompt: "Build it",
      bypassApproval: true,
      repos: ["https://github.com/pingdotgg/t3code"],
      tags: ["t3-code"],
      devinMode: "fast",
    });
    yield* api.sendMessage("devin-session", "Continue it");

    expect(requests.map((request) => request.url)).toEqual([
      "https://api.devin.ai/v3/organizations/org-test/sessions",
      "https://api.devin.ai/v3/organizations/org-test/sessions/devin-session/messages",
    ]);
    expect(requests.every((request) => request.headers.authorization === "Bearer cog_test")).toBe(
      true,
    );
    const createBody = decodeBody(requests[0]!);
    expect(createBody).toMatchObject({
      prompt: "Build it",
      resumable: true,
      bypass_approval: true,
      devin_mode: "fast",
      create_as_user_id: "user-test",
      repos: ["https://github.com/pingdotgg/t3code"],
      tags: ["t3-code"],
    });
    // `platform` selects the VM platform / outpost pool and rejects unknown
    // values, so the request must not send one.
    expect(createBody).not.toHaveProperty("platform");
    expect(decodeBody(requests[1]!)).toEqual({
      message: "Continue it",
      message_as_user_id: "user-test",
    });
  }),
);

it.effect("redacts credentials from API failures", () =>
  Effect.gen(function* () {
    const client = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({}, { status: 401 }))),
    );
    const api = yield* makeDevinCloudApi(settings).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
    );
    const result = yield* Effect.result(api.getSelf);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.message).toContain("HTTP 401");
      expect(result.failure.message).not.toContain("cog_test");
    }
  }),
);

function decodeBody(request: HttpClientRequest.HttpClientRequest): unknown {
  const bytes = (request.body as { readonly body?: Uint8Array }).body;
  return JSON.parse(new TextDecoder().decode(bytes));
}
