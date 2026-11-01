import * as Alchemy from "@/index";
import { Function } from "@/Neon/Function";
import { FunctionLogs } from "@/Neon/FunctionProvider";
import * as Schedule from "effect/Schedule";
import { providers } from "@/Neon/Providers";
import * as Test from "@/Test/Alchemy";
import * as SDK from "@distilled.cloud/neon";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import Constructor from "./fixtures/function-constructor.ts";
import LayerLive, { LayerFunction } from "./fixtures/function-layer.ts";
import { project } from "./fixtures/function-form-resources.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: providers(),
});
const Stack = Alchemy.Stack(
  "NeonFunctionForms",
  { providers: providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const scope = yield* project;
    const constructor = yield* Constructor;
    const layer = yield* LayerFunction;
    const hono = yield* Function("Hono", {
      project: scope,
      main: new URL("./fixtures/function-hono.ts", import.meta.url).href,
    });
    const bare = yield* Function("Bare", {
      project: scope,
      main: new URL("./fixtures/function-bare.ts", import.meta.url).href,
    });
    return {
      constructor: constructor.url,
      layer: layer.url,
      hono: hono.url,
      bare: bare.url,
      host: hono,
    };
  }).pipe(Effect.provide(LayerLive)),
);
const stack = beforeAll(destroy(Stack).pipe(Effect.andThen(deploy(Stack))));
afterAll(destroy(Stack));

test(
  "Effect constructor and make Layer entrypoints invoke across a URL-only binding",
  Effect.gen(function* () {
    const urls = yield* stack;
    const client = yield* HttpClient.HttpClient;
    expect(yield* (yield* client.get(urls.constructor)).text).toBe(
      "constructor",
    );
    expect(yield* (yield* client.get(urls.layer)).text).toBe(
      "layer:constructor",
    );
  }),
  {
    tags: [
      "provider:neon",
      "provider:neon:function",
      "provider:neon:project",
      "live",
    ],
    timeout: 120_000,
  },
);

test(
  "bare and Hono native exports preserve application authentication",
  Effect.gen(function* () {
    const urls = yield* stack;
    const client = yield* HttpClient.HttpClient;
    expect(yield* (yield* client.get(urls.bare)).text).toBe("bare-v2");
    expect(yield* (yield* client.get(urls.hono)).text).toBe("hono");
    expect((yield* client.get(`${urls.hono}private`)).status).toBe(401);
    const authorized = yield* client.execute(
      HttpClientRequest.get(`${urls.hono}private`).pipe(
        HttpClientRequest.setHeader("authorization", "Bearer test-caller"),
      ),
    );
    expect(yield* authorized.text).toBe("authorized");
  }),
  {
    tags: [
      "provider:neon",
      "provider:neon:function",
      "provider:neon:project",
      "live",
    ],
    timeout: 120_000,
  },
);

test.provider(
  "Function logs expose only the requested Function's application records",
  () =>
    Effect.gen(function* () {
      const { host, bare } = yield* stack;
      const service = `neon-function/${host.slug}`;
      const record = (second: number): SDK.ProjectBranchLogRecord => ({
        timestamp: `2026-09-17T00:00:0${second}Z`,
        message: `fixture-${second}`,
        source: "function",
        service_name: service,
        entity_id: "opaque-runtime-instance",
        attributes: {},
      });
      const requests: Record<string, unknown>[] = [];
      const fixture = (
        respond: (page: number) => SDK.ProjectBranchLogsQueryResponse,
      ) =>
        HttpClient.make((request) =>
          Effect.sync(() => {
            if (request.body._tag !== "Uint8Array")
              throw new Error("Expected JSON log query");
            requests.push(
              JSON.parse(new TextDecoder().decode(request.body.body)),
            );
            return HttpClientResponse.fromWeb(
              request,
              Response.json(respond(requests.length)),
            );
          }),
        );
      const selected = yield* FunctionLogs(host, { limit: 3 }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          fixture((page) =>
            page === 1
              ? {
                  logs: [
                    record(3),
                    {
                      ...record(3),
                      entity_id: host.functionId,
                      service_name: "neon-function/another",
                    },
                    { ...record(3), service_name: undefined },
                  ],
                  is_truncated: true,
                  next_cursor: "older",
                }
              : { logs: [record(2), record(1)], is_truncated: false },
          ),
        ),
        Effect.provide(SDK.fromApiKey({ apiKey: "fixture-key" })),
      );
      expect(selected.map((line) => line.message)).toEqual([
        "fixture-1",
        "fixture-2",
        "fixture-3",
      ]);
      expect(requests.length).toBe(2);
      expect(requests[0]).toMatchObject({
        source: "function",
        service_name: service,
        sort_order: "desc",
        since: "1h",
        limit: 3,
      });
      expect(typeof requests[0].end_time).toBe("string");
      expect(requests[1]).toEqual({ ...requests[0], cursor: "older" });
      for (const mode of ["repeated", "missing", "bounded"] as const) {
        requests.length = 0;
        const result = yield* FunctionLogs(host, { limit: 3 }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            fixture((page) => ({
              logs: [],
              is_truncated: true,
              next_cursor:
                mode === "missing"
                  ? undefined
                  : mode === "repeated"
                    ? "same"
                    : `page-${page}`,
            })),
          ),
          Effect.provide(SDK.fromApiKey({ apiKey: "fixture-key" })),
          Effect.as("unexpected-success"),
          Effect.catchTag("FunctionLogQueryError", (error) =>
            Effect.succeed(error.reason),
          ),
        );
        expect(result).toBe(
          mode === "bounded" ? "pagination-limit" : "invalid-cursor",
        );
        expect(requests.length).toBe(
          mode === "bounded" ? 8 : mode === "missing" ? 1 : 2,
        );
      }
      const client = yield* HttpClient.HttpClient;
      const since = yield* Effect.sync(() => new Date());
      expect(
        yield* client
          .get(bare)
          .pipe(Effect.flatMap((response) => response.text)),
      ).toBe("bare-v2");
      expect(
        yield* client
          .get(host.url)
          .pipe(Effect.flatMap((response) => response.text)),
      ).toBe("hono");
      const marker = "alchemy-neon-hono-log-probe";
      // Log ingestion is eventually consistent; poll up to 2 minutes.
      const lines = yield* FunctionLogs(host, { limit: 100, since }).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (lines) => lines.some((line) => line.message.includes(marker)),
        }),
        Effect.timeout("2 minutes"),
      );
      const observed = yield* SDK.queryProjectBranchLogs({
        project_id: host.projectId,
        branch_id: host.branchId,
        source: "function",
        service_name: service,
        start_time: since.toISOString(),
        sort_order: "desc",
        limit: 1000,
      });
      yield* Effect.logInfo(
        JSON.stringify({
          functionLogMetadata: {
            records: observed.logs.length,
            markerRecords: observed.logs.filter((line) =>
              line.message.includes(marker),
            ).length,
            serviceMatches: observed.logs.filter(
              (line) => line.service_name === service,
            ).length,
            functionSources: observed.logs.filter(
              (line) => line.source === "function",
            ).length,
            entityMatchesFunctionId: observed.logs.filter(
              (line) => line.entity_id === host.functionId,
            ).length,
            entityMatchesSlug: observed.logs.filter(
              (line) => line.entity_id === host.slug,
            ).length,
            entityPresent: observed.logs.filter(
              (line) => line.entity_id !== undefined,
            ).length,
            truncated: observed.is_truncated,
          },
        }),
      );
      expect(lines.some((line) => line.message.includes(marker))).toBe(true);
      const functions = yield* SDK.listProjectBranchFunctions({
        project_id: host.projectId,
        branch_id: host.branchId,
      });
      const sibling = functions.functions.find(
        (fn) => fn.invocation_url === bare,
      );
      if (!sibling)
        return yield* Effect.fail(
          new Error("Missing sibling Function for log isolation check"),
        );
      // The sibling's records ingest independently; poll until they appear.
      const unrelated = yield* FunctionLogs(
        { ...host, functionId: sibling.id, slug: sibling.slug },
        { limit: 100, since },
      ).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (lines) => lines.length > 0,
        }),
        Effect.timeout("2 minutes"),
      );
      expect(unrelated.length).toBeGreaterThan(0);
      expect(unrelated.some((line) => line.message.includes(marker))).toBe(
        false,
      );
    }),
  {
    tags: [
      "provider:neon",
      "provider:neon:function",
      "provider:neon:project",
      "live",
    ],
    timeout: 300_000,
  },
);
