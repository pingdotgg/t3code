import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { makeExpoApi, resolveExpoCredential, type ExpoCredential } from "./ExpoApi.ts";

const header = (credential: ExpoCredential) => ({
  source: credential.source,
  name: credential.header.name,
  value: Redacted.value(credential.header.value),
});

describe("Expo credentials", () => {
  it.effect("prefer the saved token, then EXPO_TOKEN, then the eas login session", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-expo-home-" });
      yield* fs.makeDirectory(path.join(home, ".expo"));
      yield* fs.writeFileString(
        path.join(home, ".expo", "state.json"),
        JSON.stringify({ auth: { sessionSecret: "session-secret", username: "julius" } }),
      );
      const resolve = (saved: string, env: NodeJS.ProcessEnv) =>
        resolveExpoCredential(saved).pipe(
          Effect.provideService(HostProcess.HomeDirectory, home),
          Effect.provideService(HostProcess.Environment, env),
          Effect.map(header),
        );
      expect(yield* resolve(" saved ", { EXPO_TOKEN: "env-token" })).toEqual({
        source: "settings",
        name: "authorization",
        value: "Bearer saved",
      });
      expect(yield* resolve("", { EXPO_TOKEN: "env-token" })).toEqual({
        source: "env",
        name: "authorization",
        value: "Bearer env-token",
      });
      expect(yield* resolve("", {})).toEqual({
        source: "eas-login",
        name: "expo-session",
        value: "session-secret",
      });
      yield* fs.writeFileString(
        path.join(home, ".expo", "state.json"),
        JSON.stringify({ auth: null }),
      );
      const missing = yield* resolve("", {}).pipe(Effect.exit);
      expect(Exit.isFailure(missing) && missing.cause.toString()).toContain("eas login");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    { case: "the redacted placeholder", saved: "\u2022\u2022\u2022\u2022\u2022\u2022", env: {} },
    { case: "a pasted newline", saved: "abc\ndef", env: {} },
    { case: "a malformed EXPO_TOKEN", saved: "", env: { EXPO_TOKEN: "abc def" } },
  ])("refuses $case without echoing it", ({ saved, env }) =>
    Effect.gen(function* () {
      const error = yield* resolveExpoCredential(saved).pipe(
        Effect.provideService(HostProcess.Environment, env),
        Effect.flip,
      );
      expect(error._tag).toBe("ExpoInvalidCredentialError");
      expect(error.message).not.toContain(saved || "abc def");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("Expo API", () => {
  const credential: ExpoCredential = {
    source: "eas-login",
    header: { name: "expo-session", value: Redacted.make("session-secret") },
  };

  it.effect("sends the credential and reads session endpoints once the simulator is ready", () =>
    Effect.gen(function* () {
      const requests: Array<{ headers: Record<string, string>; body: unknown }> = [];
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          const body =
            request.body._tag === "Uint8Array"
              ? (JSON.parse(new TextDecoder().decode(request.body.body)) as { variables: unknown })
              : null;
          requests.push({ headers: request.headers, body });
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              data: {
                deviceRunSessions: {
                  byId: {
                    id: "session-1",
                    status: "IN_PROGRESS",
                    remoteConfig: {
                      __typename: "AgentDeviceRunSessionRemoteConfig",
                      agentDeviceRemoteSessionUrl: "https://agent.test",
                      agentDeviceRemoteSessionToken: "agent-token",
                      webPreviewToken: "preview-token",
                      previewApiUrl: "https://preview.test?token=preview-token",
                    },
                  },
                },
              },
            }),
          );
        }),
      );
      const session = yield* makeExpoApi(http, credential).session("session-1");
      expect(requests[0]?.headers["expo-session"]).toBe("session-secret");
      expect(requests[0]?.body).toMatchObject({ variables: { id: "session-1" } });
      expect(session.status).toBe("IN_PROGRESS");
      expect(session.endpoints?.agentDevice.url).toBe("https://agent.test");
      expect(Redacted.value(session.endpoints!.agentDevice.token)).toBe("agent-token");
      expect(session.endpoints?.preview?.url).toBe("https://preview.test?token=preview-token");
      expect(Redacted.value(session.endpoints!.preview!.token)).toBe("preview-token");
    }),
  );

  it.effect("keeps the credential out of errors when Expo is unreachable", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              description: "connection reset",
            }),
          }),
        ),
      );
      const error = yield* makeExpoApi(http, credential).viewer.pipe(Effect.flip);
      expect(error.message).toContain("Expo's API is unreachable");
      expect(JSON.stringify(error)).not.toContain("session-secret");
      expect(error.cause).toBeUndefined();
      // No answer: a mutation may have run.
      expect(error.rejected).toBe(false);
    }),
  );

  it.effect("reports GraphQL errors and rejected credentials as Expo failures", () =>
    Effect.gen(function* () {
      const respond = (response: Response) =>
        HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, response)));
      const graphQl = yield* makeExpoApi(
        respond(Response.json({ errors: [{ message: "Feature not enabled" }] })),
        credential,
      )
        .availability("app-1")
        .pipe(Effect.flip);
      expect(graphQl.message).toBe(
        "Expo could not check EAS Simulator access: Feature not enabled",
      );
      const rejected = yield* makeExpoApi(respond(new Response("no", { status: 401 })), credential)
        .stop("session-1")
        .pipe(Effect.flip);
      expect(rejected.message).toBe(
        "Expo could not stop a simulator session: the eas login session was rejected (HTTP 401)",
      );
      const serverError = yield* makeExpoApi(
        respond(Response.json({ errors: [{ message: "Internal server error" }] }, { status: 502 })),
        credential,
      )
        .stop("session-1")
        .pipe(Effect.flip);
      expect(serverError.message).toBe(
        "Expo could not stop a simulator session: Internal server error",
      );
      // What Expo answers a refused request with: Apollo's default code, the
      // user's fault, and null data.
      const expoRefusal = yield* makeExpoApi(
        respond(
          Response.json({
            errors: [
              {
                message: "Experience with id 0000 does not exist.",
                extensions: {
                  code: "INTERNAL_SERVER_ERROR",
                  errorCode: "EXPERIENCE_NOT_FOUND",
                  errorType: "USER",
                  isTransient: false,
                },
              },
            ],
            data: null,
          }),
        ),
        credential,
      )
        .stop("session-1")
        .pipe(Effect.flip);
      const internalError = yield* makeExpoApi(
        respond(
          Response.json({
            errors: [
              {
                message: "Something went wrong",
                extensions: { errorCode: "INTERNAL_SERVER_ERROR" },
              },
            ],
          }),
        ),
        credential,
      )
        .stop("session-1")
        .pipe(Effect.flip);
      const transient = yield* makeExpoApi(
        respond(
          Response.json({
            errors: [
              {
                message: "Something went wrong",
                extensions: { errorCode: "INTERNAL_SERVER_ERROR", isTransient: true },
              },
            ],
          }),
        ),
        credential,
      )
        .stop("session-1")
        .pipe(Effect.flip);
      const ran = yield* makeExpoApi(
        respond(
          Response.json({
            data: { deviceRunSession: { stopDeviceRunSession: null } },
            errors: [
              { message: "Session is already stopping", extensions: { errorCode: "CONFLICT" } },
            ],
          }),
        ),
        credential,
      )
        .stop("session-1")
        .pipe(Effect.flip);
      const fault = yield* makeExpoApi(
        respond(
          Response.json({
            errors: [{ message: "Something went wrong", extensions: { errorType: "INTERNAL" } }],
          }),
        ),
        credential,
      )
        .stop("session-1")
        .pipe(Effect.flip);
      const echoed = yield* makeExpoApi(
        respond(
          Response.json({
            errors: [{ message: `Session session-secret is not yours (${"x".repeat(400)})` }],
          }),
        ),
        credential,
      )
        .stop("session-1")
        .pipe(Effect.flip);
      // A message that echoes the credential loses it, and is bounded.
      expect(echoed.message).toContain("Session [redacted] is not yours");
      expect(echoed.message).not.toContain("session-secret");
      expect(echoed.message.length).toBeLessThan(400);
      const userError = yield* makeExpoApi(
        respond(
          Response.json({
            errors: [
              { message: "Not allowed", extensions: { errorType: "USER", errorCode: "FORBIDDEN" } },
            ],
          }),
        ),
        credential,
      )
        .stop("session-1")
        .pipe(Effect.flip);
      // Expo answered and refused the first three: nothing was done. GraphQL
      // errors at a server error, a transient, internal or other non-user
      // error, or errors beside data, may come from a request that ran.
      expect([
        graphQl.rejected,
        rejected.rejected,
        userError.rejected,
        expoRefusal.rejected,
        serverError.rejected,
        internalError.rejected,
        transient.rejected,
        fault.rejected,
        ran.rejected,
      ]).toEqual([true, true, true, true, false, false, false, false, false]);
    }),
  );
});
