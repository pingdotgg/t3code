import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { describe } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";
import { expectUrlContains } from "../Utils/Http.ts";
import type { OtelSink } from "./fixtures/otel-collector-worker.ts";
import OtelCustomWorker from "./fixtures/otel-custom-worker.ts";
import OtelEventFlushWorker from "./fixtures/otel-event-flush-worker.ts";
import OtelTracedWorker from "./fixtures/otel-traced-worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const collectorMain = pathe.resolve(
  import.meta.dirname,
  "fixtures/otel-collector-worker.ts",
);

// The collector must be reachable *from another Worker*: same-account
// worker-to-worker fetches over workers.dev are blocked (error 1042), so
// the collector gets a deterministic custom hostname on the standing test
// zone instead.
const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";
const collectorHost = `otel-collector-${process.env.PULL_REQUEST ?? process.env.USER}.${zoneName}`;

// The OTLP sink both traced fixtures export to. Declared identically in
// both deploy steps so the second deploy keeps it.
const collectorWorker = () =>
  Cloudflare.Worker("OtelCollector", {
    main: collectorMain,
    env: {
      SINK: Cloudflare.DurableObject<OtelSink>("OtelSink"),
    },
    domain: collectorHost,
    compatibility: { date: "2024-09-23" },
  });

describe("Cloudflare Worker Telemetry", () => {
  test.provider(
    "OTLP telemetry exports per request (otlp binding + custom Layer)",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        // Deploy the collector first: the traced fixtures resolve
        // `COLLECTOR_URL` from the deployer environment at
        // deploy time, so its URL must exist before they deploy.
        const collector = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* collectorWorker();
          }),
        );
        // Exporters (running inside the traced Workers) push to the custom
        // domain; the test reads back over workers.dev, which is reachable
        // from outside but blocked worker-to-worker (error 1042). With a
        // custom domain attached, `collector.url` is the domain, so derive
        // the workers.dev URL from the account subdomain.
        const { accountId } = yield* yield* CloudflareEnvironment;
        const { subdomain } = yield* workers.getSubdomain({ accountId });
        const collectorUrl = `https://${collectorHost}`;
        const collected = `https://${collector.workerName}.${subdomain}.workers.dev/collected`;

        yield* expectUrlContains(collected, "otel-collector-ok", {
          timeout: "180 seconds",
        });

        // The traced fixtures read the collector URL via `Config` at deploy
        // time. The test harness snapshots its ConfigProvider before the
        // test body runs, so layer the just-learned collector URL on top of
        // the current provider for this deploy only.
        const currentConfig = yield* ConfigProvider.ConfigProvider;
        const { traced, custom, flush } = yield* stack
          .deploy(
            Effect.gen(function* () {
              yield* collectorWorker();
              const traced = yield* OtelTracedWorker;
              const custom = yield* OtelCustomWorker;
              const flush = yield* OtelEventFlushWorker;
              return { traced, custom, flush };
            }),
          )
          .pipe(
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.orElse(
                ConfigProvider.fromUnknown({
                  COLLECTOR_URL: collectorUrl,
                  OTLP_EVENT_FLUSH_URL: `${collectorUrl}/v1/traces`,
                }),
                currentConfig,
              ),
            ),
          );
        const tracedUrl = traced.url as string;
        const customUrl = custom.url as string;

        // Wait for the traced workers to serve (fresh workers.dev
        // subdomains can take minutes to start routing), then for the
        // collector's custom domain to be reachable from *inside* a Worker
        // (DNS + edge certificate issuance).
        yield* expectUrlContains(`${tracedUrl}/probe`, '"status":200', {
          timeout: "240 seconds",
          label: "collector reachable from a Worker",
        });

        // Drive one traced request on each worker now that exports can
        // reach the collector.
        yield* expectUrlContains(`${tracedUrl}/work`, "did-work", {
          timeout: "180 seconds",
        });
        yield* expectUrlContains(`${customUrl}/work`, "custom-did-work", {
          timeout: "180 seconds",
        });

        // The otlp binding-layer path: the request scope finalizer flushes
        // the OTLP buffers via ctx.waitUntil, so everything the request
        // produced arrives at the collector shortly after the response.
        yield* expectUrlContains(collected, "otel-traced-test", {
          timeout: "120 seconds",
          label: "default-path service.name",
        });
        // http.server root span from the HttpMiddleware tracer.
        yield* expectUrlContains(collected, "http.server GET");
        // Child span from Effect.fn instrumentation.
        yield* expectUrlContains(collected, "test.child-span");
        // Log record shipped by the OTLP logger.
        yield* expectUrlContains(collected, "did-work-log");
        // Default resource attributes stamped by the exporter.
        yield* expectUrlContains(collected, "alchemy.stack");
        // Exporter composition: the fixture merges a second otlp layer
        // whose traces url lands under /v1/second-traces — same spans,
        // second destination.
        yield* expectUrlContains(collected, "second-traces");

        // Custom exporter path: Effect.provide(Telemetry.layer(...)) on
        // the Worker init Effect replaces the built-in OTLP exporter.
        yield* expectUrlContains(collected, "otel-custom-test", {
          timeout: "120 seconds",
          label: "custom-path service.name",
        });
        yield* expectUrlContains(collected, "custom.child-span");
        yield* expectUrlContains(collected, "custom-work-log");

        // Durable Object event paths on deployed workerd: the Worker calls
        // its DO over HTTP and over RPC; each DO event is its own telemetry
        // scope. `state.waitUntil` is a no-op in DOs, so DO batches only
        // arrive if the DurableObjectBridge's flush actually completes
        // before/despite the event's I/O context winding down.
        const flushUrl = flush.url as string;
        yield* expectUrlContains(
          `${flushUrl}/`,
          "worker-saw:durable-object-ok",
          {
            timeout: "240 seconds",
            label: "event-flush worker via DO fetch",
          },
        );
        yield* expectUrlContains(
          `${flushUrl}/rpc`,
          "worker-saw:durable-object-rpc-ok",
          {
            timeout: "120 seconds",
            label: "event-flush worker via DO rpc",
          },
        );
        // The DO fetch event's child span…
        yield* expectUrlContains(collected, "otel-event-flush.child", {
          timeout: "120 seconds",
          label: "deployed DO fetch event batch",
        });
        // …and the DO RPC method event's child span both reach the
        // collector.
        yield* expectUrlContains(collected, "otel-event-flush.rpc", {
          timeout: "120 seconds",
          label: "deployed DO rpc event batch",
        });
      }),
    { timeout: 600_000 },
  );
});
