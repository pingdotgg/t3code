import * as railway from "@distilled.cloud/railway";
import {
  Sandbox,
  SandboxProvider,
  type SandboxProps,
} from "@/Railway/Sandbox.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { RailwayEnvironment } from "@/Railway/Environment.ts";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

const testLayer = (client: HttpClient.HttpClient) =>
  SandboxProvider().pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(
          RailwayEnvironment,
          Effect.succeed({
            ...railway.toConfig({ token: "fixture" }),
            workspaceId: "workspace",
          }),
        ),
        railway.CredentialsFromToken({ token: "fixture" }),
        Layer.succeed(HttpClient.HttpClient, client),
      ),
    ),
  );

const props: SandboxProps = { environment: { environmentId: "env" } };
const attrs: Sandbox["Attributes"] = {
  sandboxId: "box",
  environmentId: "env",
  projectId: undefined,
  region: "us-west2",
  status: "RUNNING",
  idleTimeoutMinutes: 5,
  networkIsolation: "ISOLATED",
  createdAt: "2026-09-16T00:00:00Z",
  domains: [],
};
const context = {
  id: "Box",
  fqn: "Box",
  instanceId: "instance",
  bindings: [],
  session: undefined as never,
};
const cloud = (status: Sandbox["Attributes"]["status"]) => ({
  id: attrs.sandboxId,
  environmentId: attrs.environmentId,
  region: attrs.region,
  status,
  idleTimeoutMinutes: attrs.idleTimeoutMinutes,
  networkIsolation: attrs.networkIsolation,
  createdAt: attrs.createdAt,
  domains: [],
});
const http = (respond: (query: string) => unknown) =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      if (request.body._tag !== "Uint8Array")
        throw new Error("Expected JSON request");
      const { query } = JSON.parse(new TextDecoder().decode(request.body.body));
      return HttpClientResponse.fromWeb(
        request,
        Response.json({ data: respond(query) }),
      );
    }),
  );

const immutable: Partial<SandboxProps>[] = [
  { region: "us-east4-eqdc4a" },
  { idleTimeoutMinutes: 0 },
  { networkIsolation: "PRIVATE" },
  { template: { name: "base" } },
  { variables: { TOKEN: "fixture" } },
  { publicDomains: [{ port: 3000 }] },
  { resources: { cpu: 0.5, memoryGB: 1 } },
  { sourceSandboxId: "source" },
];

describe("Railway Sandbox provider", () => {
  for (const option of immutable) {
    const name = Object.keys(option)[0];
    it.effect(`replaces when ${name} is changed or removed`, () =>
      Effect.gen(function* () {
        const provider = yield* Sandbox.Provider;
        for (const [olds, news] of [
          [props, { ...props, ...option }],
          [{ ...props, ...option }, props],
        ]) {
          expect(
            yield* provider.diff!({
              ...context,
              olds: olds!,
              news: news!,
              output: attrs,
              oldBindings: [],
              newBindings: [],
            }),
          ).toEqual({ action: "replace" });
        }
      }).pipe(
        Effect.provide(
          testLayer(
            http(() => {
              throw new Error("Diff must not perform I/O");
            }),
          ),
        ),
      ),
    );
  }

  it.effect("ignores variable and route ordering", () =>
    Effect.gen(function* () {
      const provider = yield* Sandbox.Provider;
      const olds = {
        ...props,
        variables: { A: "1", B: "2" },
        template: { variables: { A: "1", B: "2" } },
        publicDomains: [{ port: 3000 }, { port: 8080, prefix: "api" }],
      };
      const news = {
        ...props,
        variables: { B: "2", A: "1" },
        template: { variables: { B: "2", A: "1" } },
        publicDomains: [{ prefix: "api", port: 8080 }, { port: 3000 }],
      };
      expect(
        yield* provider.diff!({
          ...context,
          olds,
          news,
          output: attrs,
          oldBindings: [],
          newBindings: [],
        }),
      ).toBeUndefined();
    }).pipe(
      Effect.provide(
        testLayer(
          http(() => {
            throw new Error("Diff must not perform I/O");
          }),
        ),
      ),
    ),
  );

  it.effect(
    "fails rather than returning a sandbox that never becomes ready",
    () =>
      Effect.gen(function* () {
        const provider = yield* Sandbox.Provider;
        const fiber = yield* provider
          .reconcile({
            ...context,
            news: props,
            olds: undefined,
            output: undefined,
          })
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust("30 seconds");
        expect(yield* Fiber.join(fiber)).toMatchObject({
          _tag: "Railway.SandboxPending",
          sandboxId: "box",
          status: "CREATING",
        });
      }).pipe(
        Effect.provide(
          testLayer(
            http((query) =>
              query.includes("sandboxCreate")
                ? { sandboxCreate: cloud("CREATING") }
                : { sandbox: cloud("CREATING") },
            ),
          ),
        ),
      ),
  );

  it.effect(
    "recreates a missing cached sandbox and preserves an existing adopted one",
    () => {
      let creates = 0;
      let exists = false;
      return Effect.gen(function* () {
        const provider = yield* Sandbox.Provider;
        const recreated = yield* provider.reconcile({
          ...context,
          news: props,
          olds: props,
          output: attrs,
        });
        expect(recreated.status).toBe("RUNNING");
        expect(creates).toBe(1);
        yield* provider.reconcile({
          ...context,
          news: props,
          olds: undefined,
          output: recreated,
        });
        expect(creates).toBe(1);
      }).pipe(
        Effect.provide(
          testLayer(
            http((query) => {
              if (query.includes("sandboxCreate")) {
                creates++;
                exists = true;
                return { sandboxCreate: cloud("RUNNING") };
              }
              return { sandbox: exists ? cloud("RUNNING") : null };
            }),
          ),
        ),
      );
    },
  );

  it.effect(
    "waits for DESTROYED instead of treating DESTROYING as absent",
    () => {
      let reads = 0;
      return Effect.gen(function* () {
        const provider = yield* Sandbox.Provider;
        const fiber = yield* provider
          .delete({ ...context, olds: props, output: attrs })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust("2 seconds");
        yield* Fiber.join(fiber);
        expect(reads).toBe(3);
      }).pipe(
        Effect.provide(
          testLayer(
            http((query) =>
              query.includes("sandboxDestroy")
                ? { sandboxDestroy: cloud("DESTROYING") }
                : { sandbox: cloud(++reads >= 3 ? "DESTROYED" : "DESTROYING") },
            ),
          ),
        ),
      );
    },
  );
});
