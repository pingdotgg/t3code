import { Credentials } from "@distilled.cloud/aws/Credentials";
import { sign } from "@distilled.cloud/aws/SigV4";
import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Test from "alchemy/Test/Bun";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import Stack from "../alchemy.run.ts";

// Aurora provisioning/deletion is opt-in, as in the RDSData integration suite.
describe.skipIf(!process.env.AWS_TEST_SLOW)(
  "Drizzle + Aurora PostgreSQL",
  () => {
    const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
      providers: AWS.providers(),
      state: Alchemy.localState(),
      profile: process.env.ALCHEMY_PROFILE,
    });
    const stack = beforeAll(
      Effect.gen(function* () {
        yield* destroy(Stack);
        const outputs = yield* deploy(Stack);
        yield* deploy(Stack);
        return outputs;
      }),
      { timeout: 1_500_000 },
    );
    afterAll(destroy(Stack), { timeout: 1_500_000 });

    test.provider(
      "CRUD, TLS, least privilege, and repeated invocations",
      () =>
        Effect.gen(function* () {
          const { url } = yield* stack;
          if (!url)
            return yield* Effect.fail(new Error("Missing Function URL"));
          const client = yield* HttpClient.HttpClient;
          const getCredentials = yield* Credentials;
          expect((yield* client.get(`${url}health`)).status).toBe(403);
          const request = Effect.fn(function* (
            method: "GET" | "POST" | "PATCH" | "DELETE",
            path: string,
            body?: object,
          ) {
            const credentials = yield* getCredentials;
            const payload =
              body === undefined ? undefined : JSON.stringify(body);
            const signed = yield* sign({
              method,
              url: new URL(path, url).toString(),
              body: payload,
              service: "lambda",
              region: credentials.region,
              accessKeyId: Redacted.value(credentials.accessKeyId),
              secretAccessKey: credentials.secretAccessKey,
              sessionToken: credentials.sessionToken,
            });
            const base = HttpClientRequest.make(method)(signed.url).pipe(
              HttpClientRequest.setHeaders(signed.headers),
            );
            const response = yield* client.execute(
              payload === undefined
                ? base
                : base.pipe(
                    HttpClientRequest.bodyText(payload, "application/json"),
                  ),
            );
            return { statusCode: response.status, body: yield* response.text };
          });
          const health = yield* request("GET", "/health");
          expect(health.statusCode).toBe(200);
          expect(JSON.parse(health.body).rows).toEqual([
            {
              username: "app_iam",
              tls: true,
              can_insert: true,
              can_create: false,
            },
          ]);
          const id = "aaaaaaaa-0000-4000-8000-000000000001";
          yield* request("DELETE", `/todos/${id}`);
          expect((yield* request("GET", "/todos")).body).toBe("[]");
          const created = yield* request("POST", "/todos", {
            id,
            title: "Ship Aurora guide",
          });
          expect(created.statusCode).toBe(201);
          expect(JSON.parse(created.body)).toEqual([
            { id, title: "Ship Aurora guide", done: false },
          ]);
          const updated = yield* request("PATCH", `/todos/${id}`, {
            done: true,
          });
          expect(updated.statusCode).toBe(200);
          expect(JSON.parse(updated.body)[0].done).toBe(true);
          for (let i = 0; i < 3; i++) {
            const listed = yield* request("GET", "/todos");
            expect(listed.statusCode).toBe(200);
            expect(JSON.parse(listed.body)).toEqual([
              { id, title: "Ship Aurora guide", done: true },
            ]);
          }
          expect(
            (yield* request("POST", "/todos", { id: "invalid", title: "" }))
              .statusCode,
          ).toBe(400);
          expect((yield* request("GET", "/setup")).statusCode).toBe(404);
          expect((yield* request("DELETE", `/todos/${id}`)).statusCode).toBe(
            204,
          );
          expect((yield* request("GET", "/todos")).body).toBe("[]");
        }),
      { timeout: 120_000 },
    );
  },
);
