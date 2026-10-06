import { Credentials } from "@distilled.cloud/aws/Credentials";
import { sign } from "@distilled.cloud/aws/SigV4";
import * as dsql from "@distilled.cloud/aws/dsql";
import * as iam from "@distilled.cloud/aws/iam";
import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Test from "alchemy/Test/Bun";
import * as Core from "alchemy/Test/Core";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import Stack from "../alchemy.run.ts";

describe("Drizzle + Aurora DSQL", () => {
  const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
    providers: AWS.providers(),
    state: Alchemy.localState(),
    profile: process.env.ALCHEMY_PROFILE,
  });
  let clusterId: string | undefined;
  const stack = beforeAll(
    Effect.gen(function* () {
      yield* destroy(Stack);
      const outputs = yield* deploy(Stack);
      clusterId = outputs.clusterId;
      yield* deploy(Stack);
      return outputs;
    }),
    { timeout: 600_000 },
  );
  afterAll(
    Effect.gen(function* () {
      yield* destroy(Stack);
      if (clusterId) {
        const status = yield* Core.withProviders(
          dsql.getCluster({ identifier: clusterId }).pipe(
            Effect.map((cluster) => cluster.status),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed("NOT_FOUND"),
            ),
          ),
          { providers: AWS.providers() },
          "aws-dsql-drizzle",
        );
        expect(["DELETING", "DELETED", "NOT_FOUND"]).toContain(status);
      }
    }),
    { timeout: 600_000 },
  );

  test.provider(
    "signed HTTP CRUD with a non-admin database role and verified TLS",
    () =>
      Effect.gen(function* () {
        const { url, roleName } = yield* stack;
        if (!url) return yield* Effect.fail(new Error("Missing Function URL"));
        const policies = yield* iam.listRolePolicies({ RoleName: roleName });
        const documents = yield* Effect.forEach(
          policies.PolicyNames,
          (PolicyName) =>
            iam
              .getRolePolicy({ RoleName: roleName, PolicyName })
              .pipe(
                Effect.map((policy) =>
                  decodeURIComponent(policy.PolicyDocument),
                ),
              ),
        );
        expect(documents.join("\n")).toContain('"dsql:DbConnect"');
        expect(documents.join("\n")).not.toContain("DbConnectAdmin");

        const client = yield* HttpClient.HttpClient;
        const getCredentials = yield* Credentials;
        expect((yield* client.get(`${url}health`)).status).toBe(403);
        const request = Effect.fn(function* (
          method: "GET" | "POST" | "PATCH" | "DELETE",
          path: string,
          body?: object,
        ) {
          const credentials = yield* getCredentials;
          const payload = body === undefined ? undefined : JSON.stringify(body);
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
          return { status: response.status, body: yield* response.text };
        });
        const health = yield* request("GET", "/health");
        expect(health.status).toBe(200);
        expect(JSON.parse(health.body).rows).toEqual([
          { username: "app_user" },
        ]);
        const id = "aaaaaaaa-0000-4000-8000-000000000001";
        yield* request("DELETE", `/todos/${id}`);
        expect((yield* request("GET", "/todos")).body).toBe("[]");
        const created = yield* request("POST", "/todos", {
          id,
          text: "Ship DSQL guide",
        });
        expect(created.status).toBe(201);
        expect(JSON.parse(created.body)[0]).toMatchObject({
          id,
          text: "Ship DSQL guide",
          done: false,
        });
        const updated = yield* request("PATCH", `/todos/${id}`, { done: true });
        expect(updated.status).toBe(200);
        expect(JSON.parse(updated.body)[0].done).toBe(true);
        for (let i = 0; i < 3; i++) {
          const listed = yield* request("GET", "/todos");
          expect(listed.status).toBe(200);
          expect(JSON.parse(listed.body)).toHaveLength(1);
          expect(JSON.parse(listed.body)[0]).toMatchObject({
            id,
            text: "Ship DSQL guide",
            done: true,
          });
        }
        expect(
          (yield* request("POST", "/todos", { id: "invalid", text: "" }))
            .status,
        ).toBe(400);
        expect((yield* request("GET", "/setup")).status).toBe(404);
        expect((yield* request("DELETE", `/todos/${id}`)).status).toBe(204);
        expect((yield* request("GET", "/todos")).body).toBe("[]");
      }),
    { timeout: 120_000 },
  );
});
