import { fileURLToPath } from "node:url";
import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as iam from "@distilled.cloud/aws/iam";
import * as lambdacore from "@distilled.cloud/aws/lambda-core";
import * as LambdaWeb from "@distilled.cloud/aws/lambda-web";
import * as RDSData from "@distilled.cloud/aws/rds-data";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import EffectWebFunctionLive, { EffectWebFunction } from "./fixtures/web/effect-web.ts";
import {
  BackgroundLoopWeb,
  BackgroundLoopWebLive,
  EventSourceWeb,
  EventSourceWebLive,
} from "./fixtures/web/not-http.ts";
import RdsWebFunctionLive, { RdsWebFunction, RdsWebInfra } from "./fixtures/web/rds-web.ts";

const asyncServerMain = fileURLToPath(new URL("./fixtures/web/async-server.ts", import.meta.url));
const prebuiltMain = fileURLToPath(new URL("./fixtures/web/prebuilt/server.mjs", import.meta.url));

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:iam", "provider:aws:lambda", "live"];

class UnexpectedStatus extends Error {}

/**
 * Send a request until the endpoint answers 200. A new endpoint's domain
 * and a freshly shifted revision take a few seconds to serve.
 */
const send = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? Effect.succeed(response)
        : Effect.fail(new UnexpectedStatus(`${request.url} returned ${response.status}`)),
    ),
    Effect.retry({
      schedule: Schedule.max([Schedule.spaced("2 seconds"), Schedule.recurs(30)]),
    }),
  );

const getText = (url: string) =>
  send(HttpClientRequest.get(url)).pipe(Effect.flatMap((response) => response.text));

/** Poll `url` until its body satisfies `until`. */
const getTextUntil = (url: string, until: (body: string) => boolean) =>
  getText(url).pipe(Effect.repeat({ schedule: Schedule.spaced("2 seconds"), until, times: 30 }));

/**
 * Read a streamed body, recording when each chunk arrived. A buffered
 * bridge delivers every chunk at once; a streaming one spreads them over
 * the time the handler took to produce them.
 */
const readChunks = (response: HttpClientResponse.HttpClientResponse) =>
  response.stream.pipe(
    Stream.decodeText,
    Stream.mapEffect((text) => Effect.map(Clock.currentTimeMillis, (at) => ({ at, text }))),
    Stream.runCollect,
    Effect.map((chunks) => Array.from(chunks)),
  );

const expectStreamed = (url: string) =>
  Effect.gen(function* () {
    const chunks = yield* send(HttpClientRequest.get(`${url}/stream`)).pipe(
      Effect.flatMap(readChunks),
    );
    expect(chunks.map((c) => c.text).join("")).toBe("one\ntwo\nthree\n");
    // The handler sleeps 600 ms between chunks; buffered delivery would
    // land them together.
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.at(-1)!.at - chunks[0]!.at).toBeGreaterThan(800);
  });

const getEndpoint = (functionName: string, endpointName = "default") =>
  LambdaWeb.getWebFunctionEndpoint({ functionName, endpointName });

const expectFunctionDeleted = (functionName: string, roleName: string) =>
  Effect.gen(function* () {
    const fn = yield* LambdaWeb.getWebFunction({ functionName }).pipe(
      Effect.map(() => true),
      Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(false)),
    );
    expect(fn).toBe(false);
    const role = yield* iam.getRole({ RoleName: roleName }).pipe(
      Effect.map(() => true),
      Effect.catchTag("NoSuchEntityException", () => Effect.succeed(false)),
    );
    expect(role).toBe(false);
    const logGroups = yield* Logs.describeLogGroups({
      logGroupNamePrefix: `/aws/lambda/web/${functionName}`,
    });
    expect(logGroups.logGroups ?? []).toEqual([]);
  });

test.provider(
  "async server deployed as-is: create, update, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const declare = (props: Partial<AWS.Lambda.WebFunctionProps>) =>
        AWS.Lambda.WebFunction("AsyncServer", {
          main: asyncServerMain,
          authType: "ApplicationManaged",
          ...props,
        });

      const created = yield* stack.deploy(declare({ env: { GREETING: "hello" } }));
      expect(created.url).toBe(`https://${created.domainName}`);
      expect(created.domainName).toContain(".lambda-web.");

      const root = yield* send(HttpClientRequest.get(created.url));
      expect(yield* root.text).toBe("greeting=hello");
      expect(root.headers["x-fixture"]).toBe("async-server");
      // The server runs unwrapped: nothing set listen variables for it.
      expect(root.headers["x-port-env"]).toBe("unset");
      expect(root.headers["lambda-web-request-id"]).toBeTruthy();

      const echo = yield* send(
        HttpClientRequest.post(`${created.url}/echo`).pipe(
          HttpClientRequest.bodyText("ping", "text/plain"),
        ),
      ).pipe(Effect.flatMap((response) => response.json));
      expect(echo).toEqual({ method: "POST", body: "ping" });

      yield* expectStreamed(created.url);

      // Out-of-band: one endpoint, all traffic on the deployed revision.
      const endpoint = yield* getEndpoint(created.functionName);
      expect(endpoint.endpointType).toBe("HomeRegion");
      expect(endpoint.authType).toBe("ApplicationManaged");
      expect(endpoint.revisionWeights).toEqual([{ revisionId: created.revisionId, weight: 100 }]);
      const revision = yield* LambdaWeb.getWebFunctionRevision({
        functionName: created.functionName,
        revisionId: created.revisionId,
      });
      expect(revision.buildConfig.runtimeConfig.runtime).toBe("nodejs24.x");
      expect(revision.serviceConfig.maxConcurrencyPerEnvironment).toBe(64);
      expect(revision.serviceConfig.timeoutSeconds).toBe(30);
      expect(revision.serviceConfig.environmentVariables?.GREETING).toBe("hello");

      // Re-planning unchanged props is a noop.
      const plan = yield* stack.plan(declare({ env: { GREETING: "hello" } }));
      expect(plan.resources.AsyncServer).toMatchObject({ action: "noop" });

      // Update: new env + concurrency create a revision; the endpoint
      // shifts to it and picks up the rate limit.
      const updated = yield* stack.deploy(
        declare({ env: { GREETING: "updated" }, maxConcurrencyPerEnvironment: 32, rateLimit: 100 }),
      );
      expect(updated.functionName).toBe(created.functionName);
      expect(updated.url).toBe(created.url);
      expect(updated.revisionId).not.toBe(created.revisionId);
      const updatedEndpoint = yield* getEndpoint(updated.functionName);
      expect(updatedEndpoint.revisionWeights).toEqual([
        { revisionId: updated.revisionId, weight: 100 },
      ]);
      expect(updatedEndpoint.throttleConfig?.rateLimit).toBe(100);
      const updatedRevision = yield* LambdaWeb.getWebFunctionRevision({
        functionName: updated.functionName,
        revisionId: updated.revisionId,
      });
      expect(updatedRevision.serviceConfig.maxConcurrencyPerEnvironment).toBe(32);
      expect(yield* getTextUntil(updated.url, (body) => body === "greeting=updated")).toBe(
        "greeting=updated",
      );

      // Endpoint-only change: no new revision; unsigned callers are refused.
      const iamAuth = yield* stack.deploy(
        declare({
          env: { GREETING: "updated" },
          maxConcurrencyPerEnvironment: 32,
          rateLimit: 100,
          authType: "IamAuth",
        }),
      );
      expect(iamAuth.revisionId).toBe(updated.revisionId);
      expect((yield* getEndpoint(iamAuth.functionName)).authType).toBe("IamAuth");
      const unsigned = yield* HttpClient.get(iamAuth.url).pipe(
        Effect.map((response) => response.status),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (status) => status === 403,
          times: 30,
        }),
      );
      expect(unsigned).toBe(403);

      // Renaming the built-in endpoint creates a new one (new URL) and
      // removes the old one; the function and its revision are untouched.
      const renamed = yield* stack.deploy(
        declare({
          env: { GREETING: "updated" },
          maxConcurrencyPerEnvironment: 32,
          endpointName: "primary",
        }),
      );
      expect(renamed.functionName).toBe(created.functionName);
      expect(renamed.endpointName).toBe("primary");
      expect(renamed.url).not.toBe(created.url);
      expect(renamed.revisionId).toBe(updated.revisionId);
      const endpoints = yield* LambdaWeb.listWebFunctionEndpoints({
        functionName: renamed.functionName,
      });
      expect(endpoints.endpoints.map((e) => e.endpointName)).toEqual(["primary"]);
      expect(yield* getText(renamed.url)).toBe("greeting=updated");

      yield* stack.destroy();
      yield* expectFunctionDeleted(created.functionName, created.roleName);
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  { tags, timeout: 300_000 },
);

/** Sorted so a two-revision split compares regardless of order. */
const sortedWeights = (weights: readonly { revisionId: string; weight: number }[]) =>
  [...weights].sort((a, b) => a.revisionId.localeCompare(b.revisionId));

/** The distinct bodies `count` requests got back. */
const sampleBodies = (url: string, count: number) =>
  Effect.forEach(Array.from({ length: count }), () => getText(url)).pipe(
    Effect.map((bodies) => [...new Set(bodies)].sort()),
  );

test.provider(
  "canary: split, replace the canary, roll back, promote",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Each greeting is a new revision. "Webhooks" has no canary: it
      // follows every deploy at 100%.
      const deploy = (greeting: string, canary?: { weight: number }) =>
        stack.deploy(
          Effect.gen(function* () {
            const fn = yield* AWS.Lambda.WebFunction("Canary", {
              main: asyncServerMain,
              authType: "ApplicationManaged",
              env: { GREETING: greeting },
              ...(canary ? { canary } : {}),
            });
            const webhooks = yield* AWS.Lambda.WebFunctionEndpoint("Webhooks", {
              function: fn,
              authType: "ApplicationManaged",
            });
            return { fn, webhooks };
          }),
        );
      const weightsOf = (functionName: string) =>
        getEndpoint(functionName).pipe(Effect.map((e) => sortedWeights(e.revisionWeights)));

      // First deploy: nothing to compare against, so all traffic.
      const v1 = yield* deploy("v1", { weight: 50 });
      expect(v1.fn.revisionWeights).toEqual([{ revisionId: v1.fn.revisionId, weight: 100 }]);

      // A new revision takes the canary share; the previous one keeps the rest.
      const v2 = yield* deploy("v2", { weight: 50 });
      expect(v2.fn.revisionId).not.toBe(v1.fn.revisionId);
      const split = sortedWeights([
        { revisionId: v1.fn.revisionId, weight: 50 },
        { revisionId: v2.fn.revisionId, weight: 50 },
      ]);
      expect(sortedWeights(v2.fn.revisionWeights)).toEqual(split);
      expect(yield* weightsOf(v2.fn.functionName)).toEqual(split);
      expect(yield* sampleBodies(v2.fn.url, 30)).toEqual(["greeting=v1", "greeting=v2"]);
      // The other endpoint has no canary and moved over entirely.
      expect(v2.webhooks.revisionWeights).toEqual([{ revisionId: v2.fn.revisionId, weight: 100 }]);
      expect(yield* getTextUntil(v2.webhooks.url, (b) => b === "greeting=v2")).toBe("greeting=v2");

      // Unchanged props plan a noop.
      const plan = yield* stack.plan(
        AWS.Lambda.WebFunction("Canary", {
          main: asyncServerMain,
          authType: "ApplicationManaged",
          env: { GREETING: "v2" },
          canary: { weight: 50 },
        }),
      );
      expect(plan.resources.Canary).toMatchObject({ action: "noop" });

      // Another change during the canary replaces the canary; the stable
      // revision stays.
      const v3 = yield* deploy("v3", { weight: 50 });
      expect(sortedWeights(v3.fn.revisionWeights)).toEqual(
        sortedWeights([
          { revisionId: v1.fn.revisionId, weight: 50 },
          { revisionId: v3.fn.revisionId, weight: 50 },
        ]),
      );

      // Shift more traffic in place: no new revision.
      const shifted = yield* deploy("v3", { weight: 90 });
      expect(shifted.fn.revisionId).toBe(v3.fn.revisionId);
      expect(yield* weightsOf(shifted.fn.functionName)).toEqual(
        sortedWeights([
          { revisionId: v1.fn.revisionId, weight: 10 },
          { revisionId: v3.fn.revisionId, weight: 90 },
        ]),
      );

      // Roll back: all traffic to the stable revision.
      const rolledBack = yield* deploy("v3", { weight: 0 });
      expect(rolledBack.fn.revisionId).toBe(v3.fn.revisionId);
      expect(rolledBack.fn.revisionWeights).toEqual([
        { revisionId: v1.fn.revisionId, weight: 100 },
      ]);
      expect(yield* getTextUntil(rolledBack.fn.url, (b) => b === "greeting=v1")).toBe(
        "greeting=v1",
      );
      // A rollback on one endpoint leaves the others on the new revision.
      expect(yield* getText(rolledBack.webhooks.url)).toBe("greeting=v3");

      // Promote: remove `canary`.
      const promoted = yield* deploy("v3");
      expect(yield* weightsOf(promoted.fn.functionName)).toEqual([
        { revisionId: v3.fn.revisionId, weight: 100 },
      ]);
      expect(yield* getTextUntil(promoted.fn.url, (b) => b === "greeting=v3")).toBe("greeting=v3");

      yield* stack.destroy();
      yield* expectFunctionDeleted(promoted.fn.functionName, promoted.fn.roleName);
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  { tags, timeout: 600_000 },
);

test.provider(
  "Effect fetch handler with bindings and streaming",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const fn = yield* stack.deploy(EffectWebFunction.pipe(Effect.provide(EffectWebFunctionLive)));

      expect(yield* getText(fn.url)).toBe("hello from effect");

      const runtime = (yield* send(HttpClientRequest.get(`${fn.url}/runtime`)).pipe(
        Effect.flatMap((response) => response.json),
      )) as { endpoint?: string; requestId?: string; hasCredentials: boolean; region?: string };
      expect(runtime.endpoint).toMatch(/:\d+$/);
      expect(runtime.requestId).toBeTruthy();
      expect(runtime.hasCredentials).toBe(true);

      // The S3 bindings granted the execution role access and the runtime
      // signs with the role's credentials.
      const s3 = yield* send(HttpClientRequest.get(`${fn.url}/s3?key=effect.txt`)).pipe(
        Effect.flatMap((response) => response.json),
      );
      expect(s3).toEqual({ key: "effect.txt", body: `written by ${stack.stage}` });

      yield* expectStreamed(fn.url);

      yield* stack.destroy();
      yield* expectFunctionDeleted(fn.functionName, fn.roleName);
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  { tags, timeout: 300_000 },
);

test.provider(
  "prebuilt directory deployed as-is",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const fn = yield* stack.deploy(
        AWS.Lambda.WebFunction("Prebuilt", {
          main: prebuiltMain,
          bundle: false,
          authType: "ApplicationManaged",
        }),
      );
      const body = yield* getText(fn.url);
      expect(body).toMatch(/^prebuilt on .+:\d+$/);

      yield* stack.destroy();
      yield* expectFunctionDeleted(fn.functionName, fn.roleName);
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  { tags, timeout: 240_000 },
);

test.provider(
  "a rejected create does not strand the execution role",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const declaration = AWS.Lambda.WebFunction("Rejected", {
        main: asyncServerMain,
        authType: "ApplicationManaged",
        // Reserved for Lambda: CreateWebFunction rejects the revision after
        // the execution role already exists.
        env: { AWS_LAMBDA_HTTP_ENDPOINT: "127.0.0.1:1" },
      });
      const failure = yield* stack.deploy(declaration).pipe(Effect.flip);
      expect(String(failure)).toContain("ValidationException");

      // Physical names start with the (truncated) stack name.
      const prefix = stack.name
        .replaceAll(/[^a-zA-Z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .slice(0, 32);
      const roles = iam.listRoles.items({}).pipe(
        Stream.filter((role) => role.RoleName.startsWith(prefix)),
        Stream.map((role) => role.RoleName),
        Stream.runCollect,
        Effect.map((names) => Array.from(names)),
      );
      expect((yield* roles).length).toBeGreaterThan(0);

      yield* stack.destroy();
      expect(yield* roles).toEqual([]);
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  { tags, timeout: 180_000 },
);

test.provider(
  "event sources and background loops fail at plan",
  (stack) =>
    Effect.gen(function* () {
      const failure = <A, E, R>(plan: Effect.Effect<A, E, R>) =>
        plan.pipe(
          Effect.exit,
          Effect.map((exit) => (exit._tag === "Failure" ? String(Cause.squash(exit.cause)) : "")),
        );

      expect(
        yield* failure(stack.plan(EventSourceWeb.pipe(Effect.provide(EventSourceWebLive)))),
      ).toContain(
        'AWS.Lambda.QueueEventSource needs an AWS.Lambda.Function, but "EventSourceWeb" is an AWS.Lambda.WebFunction',
      );
      expect(
        yield* failure(stack.plan(BackgroundLoopWeb.pipe(Effect.provide(BackgroundLoopWebLive)))),
      ).toContain("ServerHost");
    }),
  { tags, timeout: 60_000 },
);

// Slow: the network connector takes ~3 minutes to become ACTIVE.
test.provider.skipIf(!!process.env.FAST)(
  "vpc routes outbound traffic through the VPC",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // The VPC's Amazon-provided resolver (base + 2) only answers from
      // inside the VPC: a function without VPC egress can't reach it.
      const resolverUrl = (url: string) => `${url}/dns?server=10.61.0.2&name=aws.amazon.com`;
      const deploy = (withVpc: boolean) =>
        stack.deploy(
          Effect.gen(function* () {
            const network = yield* AWS.EC2.Network("WebVpc", {
              cidrBlock: "10.61.0.0/16",
              availabilityZones: 2,
            });
            const sg = yield* AWS.EC2.SecurityGroup("WebVpcSg", { vpcId: network.vpcId });
            const fn = yield* AWS.Lambda.WebFunction("VpcFunction", {
              main: asyncServerMain,
              authType: "ApplicationManaged",
              ...(withVpc
                ? { vpc: { subnetIds: network.privateSubnetIds, securityGroupIds: [sg.groupId] } }
                : {}),
            });
            // A second endpoint: when `vpc` is removed it moves after the
            // built-in one, so it is the one that releases the connector.
            const extra = yield* AWS.Lambda.WebFunctionEndpoint("VpcExtra", {
              function: fn,
              authType: "ApplicationManaged",
            });
            return { fn, extraUrl: extra.url };
          }),
        );

      const dns = (url: string) =>
        send(HttpClientRequest.get(resolverUrl(url))).pipe(
          Effect.flatMap((response) => response.json),
          Effect.map((body) => body as { ok: boolean; addresses?: string[]; error?: string }),
        );

      const { fn: before } = yield* deploy(false);
      expect((yield* dns(before.url)).ok).toBe(false);

      const { fn: after, extraUrl } = yield* deploy(true);
      expect(after.revisionId).not.toBe(before.revisionId);
      const resolved = yield* dns(after.url).pipe(
        Effect.repeat({ schedule: Schedule.spaced("3 seconds"), until: (r) => r.ok, times: 20 }),
      );
      expect(resolved.ok).toBe(true);
      expect(resolved.addresses?.length).toBeGreaterThan(0);

      // Out-of-band: the revision pins a version of a WebFunction connector.
      const revision = yield* LambdaWeb.getWebFunctionRevision({
        functionName: after.functionName,
        revisionId: after.revisionId,
      });
      const connectorArn = revision.serviceConfig.egressNetworkConnectorArn!;
      expect(connectorArn).toMatch(/:network-connector:.+:\d+$/);
      const connectorId = connectorArn.split(":").at(-2)!;
      const connector = yield* lambdacore.getNetworkConnector({ Identifier: connectorId });
      expect(connector.State).toBe("ACTIVE");
      expect(
        connector.Configuration?.VpcEgressConfiguration?.AssociatedComputeResourceTypes,
      ).toEqual(["WebFunction"]);

      // VPC egress needs a single-Region endpoint.
      const multiRegion = yield* stack
        .plan(
          AWS.Lambda.WebFunction("VpcFunction", {
            main: asyncServerMain,
            authType: "ApplicationManaged",
            vpc: { subnetIds: ["subnet-0"], securityGroupIds: ["sg-0"] },
            regions: ["us-east-1"],
          }),
        )
        .pipe(Effect.flip);
      expect(String(multiRegion)).toContain("WebFunctionVpcRequiresHomeRegion");

      const connectorGone = lambdacore.getNetworkConnector({ Identifier: connectorId }).pipe(
        Effect.map(() => false),
        Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(true)),
      );
      const operatorRole = connector.OperatorRole!.split("/").pop()!;
      const operatorRoleGone = iam.getRole({ RoleName: operatorRole }).pipe(
        Effect.map(() => false),
        Effect.catchTag("NoSuchEntityException", () => Effect.succeed(true)),
      );
      expect((yield* dns(extraUrl)).ok).toBe(true);

      // Removing `vpc` releases the connector and its operator role in the
      // same deploy, once no endpoint serves a revision that uses it.
      const { fn: removed, extraUrl: removedExtraUrl } = yield* deploy(false);
      expect(yield* connectorGone).toBe(true);
      expect(yield* operatorRoleGone).toBe(true);
      expect((yield* dns(removed.url)).ok).toBe(false);
      expect((yield* dns(removedExtraUrl)).ok).toBe(false);

      yield* stack.destroy();
      yield* expectFunctionDeleted(after.functionName, after.roleName);
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  { tags: [...tags, "provider:aws:ec2"], timeout: 1_500_000 },
);

// Slow: the endpoint replicates the revision to every Region.
test.provider.skipIf(!!process.env.FAST)(
  "regions serves from several Regions behind one global domain",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (regions: string[] | undefined) =>
        stack.deploy(
          AWS.Lambda.WebFunction("Global", {
            main: asyncServerMain,
            authType: "ApplicationManaged",
            env: { GREETING: "global" },
            ...(regions ? { regions } : {}),
          }),
        );

      const global = yield* deploy(["us-east-1"]);
      expect(global.domainName).toContain(".lambda-web.global.on.aws");
      expect(global.endpointType).toBe("MultiRegion");
      const endpoint = yield* getEndpoint(global.functionName);
      expect(endpoint.endpointType).toBe("MultiRegion");
      expect([...endpoint.regions].sort()).toEqual(["us-east-1", "us-west-2"]);
      expect(yield* getTextUntil(global.url, (body) => body === "greeting=global")).toBe(
        "greeting=global",
      );

      // Regions are immutable on an endpoint: changing them recreates it
      // with a new domain; the function and its revision stay.
      const home = yield* deploy(undefined);
      expect(home.functionName).toBe(global.functionName);
      expect(home.url).not.toBe(global.url);
      expect((yield* getEndpoint(home.functionName)).endpointType).toBe("HomeRegion");
      expect(home.endpointType).toBe("HomeRegion");
      expect(yield* getText(home.url)).toBe("greeting=global");

      yield* stack.destroy();
      yield* expectFunctionDeleted(global.functionName, global.roleName);
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  { tags, timeout: 900_000 },
);

// Slow: an Aurora cluster takes ~10 minutes to create and to delete.
test.provider.skipIf(!!process.env.FAST)(
  "RDS.Connect requests VPC access through the binding channel",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { api, cluster, secret } = yield* stack.deploy(
        Effect.gen(function* () {
          const { cluster, secret } = yield* RdsWebInfra;
          const api = yield* RdsWebFunction;
          return { api, cluster, secret };
        }).pipe(Effect.provide(RdsWebFunctionLive)),
      );

      // The binding's subnets and security group became the function's
      // egress connector, though the function sets no `vpc` prop.
      const revision = yield* LambdaWeb.getWebFunctionRevision({
        functionName: api.functionName,
        revisionId: api.revisionId,
      });
      const connectorArn = revision.serviceConfig.egressNetworkConnectorArn!;
      expect(connectorArn).toMatch(/:network-connector:.+:\d+$/);
      const connector = yield* lambdacore.getNetworkConnector({
        Identifier: connectorArn.split(":").at(-2)!,
      });
      expect(connector.Configuration?.VpcEgressConfiguration?.SubnetIds).toHaveLength(2);

      // Bootstrap the IAM-auth database user through the Data API.
      for (const sqlText of [
        "DO $$ BEGIN CREATE USER app_iam WITH LOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$",
        "GRANT rds_iam TO app_iam",
      ]) {
        yield* RDSData.executeStatement({
          resourceArn: cluster.dbClusterArn,
          secretArn: secret.secretArn,
          database: "app",
          sql: sqlText,
        }).pipe(
          Effect.retry({
            while: (e) => e._tag === "DatabaseResumingException",
            schedule: Schedule.spaced("5 seconds"),
            times: 24,
          }),
        );
      }

      // A real query: IAM token, TLS, and a socket into the private subnets.
      const health = yield* send(HttpClientRequest.get(`${api.url}/drizzle-health`)).pipe(
        Effect.flatMap((response) => response.json),
      );
      expect(health).toEqual({ rows: [{ one: 1 }] });

      yield* stack.destroy();
      yield* expectFunctionDeleted(api.functionName, api.roleName);
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  { tags: [...tags, "provider:aws:rds", "provider:aws:ec2"], timeout: 2_700_000 },
);

test.provider(
  "out-of-range settings fail at plan",
  (stack) =>
    Effect.gen(function* () {
      const planError = <A, E, R>(declaration: Effect.Effect<A, E, R>) =>
        stack.plan(declaration).pipe(
          Effect.exit,
          Effect.map((exit) => (exit._tag === "Failure" ? String(Cause.squash(exit.cause)) : "")),
        );
      const fn = (props: Partial<AWS.Lambda.WebFunctionProps>) =>
        AWS.Lambda.WebFunction("Invalid", {
          main: asyncServerMain,
          authType: "ApplicationManaged",
          ...props,
        });

      expect(yield* planError(fn({ rateLimit: 1500 }))).toContain("rateLimit 1500 is not allowed");
      expect(yield* planError(fn({ rateLimit: 150 }))).toContain("e.g. 100 or 200");
      expect(yield* planError(fn({ maxEnvironments: 1 }))).toContain(
        "maxEnvironments 1 is not allowed",
      );
      expect(yield* planError(fn({ canary: { weight: 150 } }))).toContain(
        "canary weight 150 is not allowed: use a whole number from 0 to 100.",
      );
      expect(yield* planError(fn({ canary: { weight: 12.5 } }))).toContain(
        "canary weight 12.5 is not allowed",
      );
      expect(yield* planError(fn({ maxConcurrencyPerEnvironment: 129 }))).toContain(
        "maxConcurrencyPerEnvironment 129 is not allowed",
      );
      expect(yield* planError(fn({ timeout: Duration.minutes(20) }))).toContain(
        "timeout of 1200 seconds is not allowed",
      );
      expect(
        yield* planError(
          Effect.gen(function* () {
            const api = yield* fn({});
            return yield* AWS.Lambda.WebFunctionEndpoint("InvalidEndpoint", {
              function: api,
              authType: "ApplicationManaged",
              rateLimit: 2500,
            });
          }),
        ),
      ).toContain("rateLimit 2500 is not allowed");

      expect(
        yield* planError(
          fn({
            vpc: { subnetIds: ["subnet-0"], securityGroupIds: ["sg-0"] },
            regions: ["us-east-1"],
          }),
        ),
      ).toContain("`vpc` can't be combined with `regions`");

      // Valid boundaries plan cleanly.
      const ok = yield* stack.plan(
        fn({ rateLimit: 0, maxEnvironments: 2, maxConcurrencyPerEnvironment: 128 }),
      );
      expect(ok.resources.Invalid).toMatchObject({ action: "create" });
    }),
  { tags, timeout: 60_000 },
);
