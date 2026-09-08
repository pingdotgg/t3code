/**
 * `alchemy dev` stress suite.
 *
 * Every other dev test in this repo asserts that a stack CONVERGES. This
 * one asserts that the dev server SURVIVES — that no sequence of edits a
 * developer can perform while `alchemy dev` is running kills it, wedges it,
 * or leaves it serving stale code.
 *
 * Topology under test (one cross-cloud stack, see ../alchemy.run.ts):
 *
 *   AWS (floci emulator)          Cloudflare (workerd + docker)
 *   ────────────────────          ─────────────────────────────
 *   Lambda ApiFunction  ◀──────── Worker ApiWorker   (path `main`)
 *     ├ S3 StressBucket   cross-  Worker EchoWorker  (Effect-native `main`)
 *     ├ DynamoDB Table    cloud     ├ KV + R2 + Durable Object
 *     └ SQS + consumer      hop     └ Container SandboxContainer
 *   Website.StaticSite            Website.StaticSite (build mode)
 *     (dev-command child)
 *
 * The suite runs ONE dev server for its whole lifetime and accumulates
 * churn on it — that accumulation IS the stress. Phases run in order and
 * each one leaves the stack healthy for the next.
 *
 * Two distinct reload paths are told apart throughout by
 * `server.planCount`, which counts `Plan:` renders (i.e. exec-child
 * restarts). Both paths put new code in front of a request within ~2s —
 * the local Worker provider's bundler watch loop always wins that race —
 * so the discriminator is what happens AFTER the swap:
 *
 *   - a file only the BUNDLER sees → hot swap, and `planCount` never
 *     (`src/api/marker.ts`)          moves, however long you wait.
 *   - a file the STACK imports     → hot swap, and then `bun --watch`
 *     (`src/echo/marker.ts`)         re-runs the stack (~4s), replan,
 *                                    re-apply. `planCount` goes UP.
 *
 * A failed rebuild takes its own Worker off the air until the next good
 * save; what must never happen is the CLI dying or an UNRELATED resource
 * going with it. That is what the resilience phases assert.
 *
 * Requires Docker: the AWS half runs in floci and the Cloudflare Container
 * runs as a real container. No cloud credentials are used or needed.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import { PORTS } from "../src/ports.ts";
import {
  at,
  DevServer,
  dockerAvailable,
  fetchJson,
  fetchOk,
  freePinnedPorts,
  makeScratchProject,
  PollTimeout,
  resetFlociEmulator,
  pollUntil,
  waitForJson,
} from "./harness.ts";
import {
  echoInboxClass,
  echoQueueBindings,
  echoQueueLayers,
  echoQueueRoutes,
  echoStreamImport,
  extraWorkerDeclaration,
  extraWorkerOutput,
  extraWorkerSource,
  lambdaArchiveBindings,
  lambdaArchiveRoutes,
  portSquatterDeclaration,
  portSquatterSource,
  reportFunctionDeclaration,
  reportFunctionImport,
  reportFunctionOutput,
  reportFunctionSource,
  secondImageBindings,
  secondImageImport,
  secondImageLayer,
  secondImageRoutes,
  secondImageSource,
  secondImageWorkerImport,
} from "./mutations.ts";

const STAGE = "dev-stress";

// Long budgets: the first apply builds a Lambda bundle and a MicroVM
// image, boots floci, starts four workerd instances, runs a site build,
// and pulls a container image. Later phases are fast because only the
// delta re-applies.
//
// These are deliberately LARGER than the sum of every bounded poll inside
// a phase. `bun test` kills every child process the file spawned the
// moment a test hits its timeout (`killed N dangling processes`) — which
// would take the dev server down and turn one slow assertion into a
// cascade of meaningless failures in every later phase. A phase must
// therefore always fail through a `pollUntil` timeout (server still
// alive, output tail attached), never through bun's.
const BOOT_TIMEOUT = 1_800_000;
const PHASE_TIMEOUT = 1_800_000;

let server: DevServer;
let cfSiteUrl: string;
/** Cursor into the CLI output, advanced past phases that expect errors. */
let cleanCursor = 0;

/** URL on a floci host-routed address (`*.localhost.floci.io`). */
const at2 = (host: string, port: number, path: string) =>
  new URL(path, `http://${host}:${port}`);

const echo = (path: string) => at(PORTS.echo, path);
const api = (path: string) => at(PORTS.api, path);
const extra = (path: string) => at(PORTS.extra, path);
const awsSite = (path: string) => at(PORTS.awsSite, path);
const extraAlt = (path: string) => at(PORTS.extraAlt, path);
const microvm = (path: string) => at(PORTS.microvm, path);
const ecs = (path: string) => at(PORTS.ecs, path);
const ecsInline = (path: string) => at(PORTS.ecsInline, path);

/**
 * Poll an ECS-served URL until its TEXT body matches. The busybox httpd
 * containers serve plain files; a container mid-roll refuses connections.
 */
const waitForText = async (
  what: string,
  url: URL,
  expected: string,
  options?: { tries?: number; delayMs?: number },
): Promise<void> => {
  let last = "no response yet";
  try {
    await pollUntil(
      what,
      async () => {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
          const text = (await res.text()).trim();
          last = `${res.status} ${text.slice(0, 200)}`;
          return res.ok && text === expected ? true : undefined;
        } catch (cause) {
          last = `error: ${String(cause).slice(0, 200)}`;
          return undefined;
        }
      },
      { tries: 240, delayMs: 1_000, server, ...options },
    );
  } catch (cause) {
    if (cause instanceof PollTimeout) {
      cause.message = `${cause.message.split("\n")[0]}\n--- last response from ${url} ---\n${last}\n${cause.message.split("\n").slice(1).join("\n")}`;
    }
    throw cause;
  }
};

/** Source text for a marker module — the suite's unit of observable change. */
const markerModule = (name: string, value: string) =>
  `export const ${name} = ${JSON.stringify(value)};\n`;

let lambdaMarkerSeq = 0;
/**
 * Bump the Lambda's marker and wait for the emulator to serve it, observed
 * THROUGH the cross-cloud hop. Called after every phase that makes the
 * engine re-reconcile the Function, because that is exactly where hot
 * swap used to die: an engine update re-points the function's code at a
 * content-addressed S3 key, detaching it from the watch loop's stable dev
 * key, and the next marker edit was silently ignored until the next engine
 * update (fixed in FlociFunctionProvider — this pins it).
 */
const expectLambdaHotSwapStillWorks = async (context: string) => {
  const marker = `lambda-after-${context}-${++lambdaMarkerSeq}`;
  server.write("src/lambda/marker.ts", markerModule("LAMBDA_MARKER", marker));
  await waitForJson<{ marker: string }>(
    `the Lambda to hot-swap to ${marker} (${context})`,
    api("/aws/"),
    (body) => body.marker === marker,
    { tries: 120, delayMs: 1_000, server },
  );
};

const messageModule = (value: string) =>
  `export const message = () => ${JSON.stringify(value)};\n`;

/** Is a port refusing connections (i.e. nothing is serving there)? */
const isClosed = async (url: URL) => {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return false;
  } catch {
    return true;
  }
};

/**
 * Has `url` stopped serving the worker that used to answer with `marker`?
 * A deleted local Worker normally closes its port, but a lingering dev
 * proxy answering 5xx counts as "gone" too — what matters is that the
 * removed code is no longer reachable.
 */
const stoppedServing = async (url: URL, marker: string) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return true;
    const body = (await res.json()) as { marker?: string };
    return body.marker !== marker;
  } catch {
    return true;
  }
};

beforeAll(async () => {
  // Docker is a hard requirement, not a reason to skip: floci hosts the
  // whole AWS half and the Container and MicroVM are real containers. A
  // machine without it must fail this suite, not quietly pass it.
  if (!dockerAvailable) {
    throw new Error(
      "dev-stress requires Docker (floci, Cloudflare Containers, MicroVMs). " +
        "Start the Docker daemon and re-run.",
    );
  }
  resetFlociEmulator();
  freePinnedPorts(Object.values(PORTS));
  const cwd = makeScratchProject(STAGE);
  server = new DevServer({ cwd, stage: STAGE });

  // The first apply is done when the CLI prints its `Done:` summary.
  await pollUntil(
    "the first dev apply to complete",
    () => (server.doneCount >= 1 ? true : undefined),
    { tries: 1_700, delayMs: 1_000, server },
  );
}, BOOT_TIMEOUT);

afterAll(async () => {
  if (!server) return;
  await server.shutdown();
  if (!process.env.NO_DESTROY) {
    server.destroyStack();
    if (!process.env.DEBUG) {
      fs.rmSync(server.cwd, { recursive: true, force: true });
    }
  }
}, 300_000);

// ───────────────────────────────────────────────────────────────────────
// Phase 1 — the stack converges, locally, across both clouds.
// ───────────────────────────────────────────────────────────────────────

test(
  "boots: every local resource serves, and the cross-cloud hop works",
  async () => {
    server.assertAlive("boot");

    // ── Cloudflare, Effect-native worker ──
    expect(
      await fetchJson<{ marker: string }>(echo("/marker")),
    ).toEqual({ marker: "echo-v1" });

    expect(await fetchJson<{ value: string }>(echo("/kv?key=boot"))).toEqual({
      value: "kv:boot",
    });

    const r2 = await fetchJson<{ text: string; keys: string[] }>(echo("/r2"));
    expect(r2.text).toBe("hello from r2");
    expect(r2.keys).toContain("hello.txt");

    // Durable Object state is real state, not a stub.
    const first = await fetchJson<{ count: number }>(echo("/counter"));
    const second = await fetchJson<{ count: number }>(echo("/counter"));
    expect(second.count).toBe(first.count + 1);

    // ── Cloudflare Container (docker), reached through the DO ──
    const sandbox = await fetchJson<{ greeting: string; marker: string }>(
      echo("/sandbox"),
      undefined,
      // The image may still be pulling/starting on the first request.
      { tries: 180, delayMs: 1_000 },
    );
    expect(sandbox.greeting).toBe("hello-from-container");
    expect(sandbox.marker).toBe("sandbox-v1");

    // ── #1334: the container reaches a service on the HOST through an env
    // var written as `http://localhost:…` (the dev runtime rewrites the
    // loopback host to `host.docker.localhost`; Linux unix-socket-tunnels
    // it into the sidecar netns instead of SYNing the docker bridge) ──
    const hostFetch = await fetchJson<{ target: string; body: string }>(
      echo("/sandbox/host-fetch"),
      undefined,
      { tries: 60, delayMs: 1_000 },
    );
    expect(hostFetch.target).toBe("http://host.docker.localhost:8793");
    expect(hostFetch.body).toContain("aws-site-env-v1");

    // ── Cloudflare, path-`main` worker ──
    expect(
      await fetchJson<{ marker: string; message: string }>(api("/marker")),
    ).toEqual({ marker: "api-v1", message: "message-v1" });

    const env = await fetchJson<{
      API_VARIABLE: string;
      AWS_LAMBDA_URL: string;
    }>(api("/env"));
    expect(env.API_VARIABLE).toBe("api-variable-v1");
    // Local identity: the Lambda URL is the emulator's, not real AWS.
    expect(env.AWS_LAMBDA_URL).toContain("localhost:4566");

    // ── CROSS-CLOUD: local workerd → the floci-hosted Lambda URL ──
    const lambda = await fetchJson<{ marker: string; variable: string }>(
      api("/aws/"),
      undefined,
      { tries: 120, delayMs: 1_000 },
    );
    expect(lambda).toEqual({
      marker: "lambda-v1",
      variable: "lambda-variable-v1",
    });

    // ── AWS data plane, driven through the cross-cloud hop ──
    expect(await fetchJson<{ text: string }>(api("/aws/s3"))).toEqual({
      text: "hello from s3",
    });
    expect(await fetchJson<{ text: string }>(api("/aws/dynamo"))).toEqual({
      text: "hello from dynamo",
    });

    // SQS produce → floci poller → the same Lambda's consumer → DynamoDB.
    const message = { id: crypto.randomUUID() };
    await fetchOk(api("/aws/queue/send"), {
      method: "POST",
      body: JSON.stringify(message),
    });
    const delivered = await waitForJson<{ body: string | null }>(
      "the queue message to be consumed",
      api(`/aws/queue/messages?id=${message.id}`),
      (body) => body.body !== null,
      { tries: 120, delayMs: 500, server },
    );
    expect(JSON.parse(delivered.body!)).toEqual(message);

    // ── AWS ECS: floci runs the services' tasks as real containers on
    // the host daemon; bridge networking publishes the baked ports. First
    // contact can wait out the image build + scheduler launch.
    await waitForText(
      "the context-built ECS service to serve",
      ecs("/"),
      "ecs-site-v1",
      { tries: 300 },
    );
    await waitForText(
      "the ECS service's baked Dockerfile marker",
      ecs("/baked.txt"),
      "dockerfile-v1",
    );
    await waitForText(
      "the ECS service's task-definition env",
      ecs("/env.txt"),
      "ecs-env-v1",
    );
    await waitForText(
      "the inline-Dockerfile ECS service to serve",
      ecsInline("/"),
      "ecs-inline-v1",
      { tries: 300 },
    );

    // ── AWS Website: the dev-command child, on its pinned port ──
    expect(await (await fetchOk(awsSite("/"))).text()).toContain("aws-site-v1");
    const siteEnv = await fetchJson<{ marker: string; pid: number }>(
      awsSite("/__dev-env"),
    );
    expect(siteEnv.marker).toBe("aws-site-env-v1");

    // ── Cloudflare Website: build mode, served by a local Worker ──
    cfSiteUrl = await pollUntil(
      "cfSiteUrl in the stack outputs",
      () => server.outputUrl("cfSiteUrl"),
      { tries: 60, delayMs: 1_000, server },
    );
    expect(cfSiteUrl).toMatch(/^http:\/\/localhost:\d+/);
    expect(await (await fetchOk(new URL("/", cfSiteUrl))).text()).toContain(
      "cf-site-v1",
    );

    // Nothing in a clean boot may look like a failure.
    expect(server.output).not.toContain("alchemy dev: run failed");
    expect(server.output).not.toContain("alchemy dev: apply failed");
    cleanCursor = server.mark();
  },
  PHASE_TIMEOUT,
);

test(
  "cross-cloud: a Cloudflare Worker boots an AWS Lambda MicroVM and drives both its protocols",
  async () => {
    // Boot → wait for RUNNING → auth token → typed RPC + raw HTTPS →
    // terminate, all from local workerd against the floci emulator.
    const roundtrip = await fetchJson<{
      microvmId: string;
      reply: string;
      marker: string;
      echo: string;
    }>(microvm("/roundtrip?message=stress"), undefined, {
      tries: 240,
      delayMs: 1_000,
    });
    expect(roundtrip.microvmId).toBeTruthy();
    expect(roundtrip.reply).toBe("hello, stress!");
    expect(roundtrip.marker).toBe("vm-v1");
    expect(roundtrip.echo).toBe("stress");
    server.assertAlive("microvm roundtrip");
  },
  PHASE_TIMEOUT,
);

// ───────────────────────────────────────────────────────────────────────
// Phase 2 — the two reload paths, told apart.
// ───────────────────────────────────────────────────────────────────────

test(
  "hot reload (bundler path): editing a file the stack never imports swaps the script without re-running the stack",
  async () => {
    const plansBefore = server.planCount;
    const counterBefore = (
      await fetchJson<{ count: number }>(echo("/counter"))
    ).count;

    server.write("src/api/marker.ts", markerModule("API_MARKER", "api-v2"));

    await waitForJson<{ marker: string }>(
      "ApiWorker to serve api-v2",
      api("/marker"),
      (body) => body.marker === "api-v2",
      { server },
    );

    // The whole point of this path: the stack process never re-ran. A
    // re-plan would trail the swap by a couple of seconds, so settle well
    // past that before claiming it never came.
    await Bun.sleep(20_000);
    expect(server.planCount).toBe(plansBefore);
    server.assertAlive("bundler hot swap");

    // And nothing else moved: the sibling worker's DO kept its state.
    const counterAfter = (await fetchJson<{ count: number }>(echo("/counter")))
      .count;
    expect(counterAfter).toBe(counterBefore + 1);
  },
  PHASE_TIMEOUT,
);

test(
  "hot reload (watch path): editing a file the stack imports re-runs the stack and keeps sidecar children alive",
  async () => {
    const plansBefore = server.planCount;
    // The dev-command child lives in the provider sidecar, which is meant
    // to survive user-code restarts. Its pid is the proof.
    const sitePidBefore = (
      await fetchJson<{ pid: number }>(awsSite("/__dev-env"))
    ).pid;

    server.write("src/echo/marker.ts", markerModule("ECHO_MARKER", "echo-v2"));

    await waitForJson<{ marker: string }>(
      "EchoWorker to serve echo-v2",
      echo("/marker"),
      (body) => body.marker === "echo-v2",
      { server },
    );

    // The re-plan trails the hot swap — wait for it rather than sampling.
    await server.waitForPlanAfter(plansBefore);
    server.assertAlive("watch-path reload");

    // The sidecar-hosted dev server was NOT bounced by a user-code reload.
    const sitePidAfter = (await fetchJson<{ pid: number }>(awsSite("/__dev-env")))
      .pid;
    expect(sitePidAfter).toBe(sitePidBefore);

    // The bundler-path worker was not disturbed either.
    expect(
      (await fetchJson<{ marker: string }>(api("/marker"))).marker,
    ).toBe("api-v2");
  },
  PHASE_TIMEOUT,
);

test(
  "hot reload (AWS): editing the Lambda's source hot-swaps its code in the emulator",
  async () => {
    server.write(
      "src/lambda/marker.ts",
      markerModule("LAMBDA_MARKER", "lambda-v2"),
    );

    // Observed THROUGH the cross-cloud hop, so this also re-proves that the
    // Worker → Lambda edge still resolves after both sides reloaded.
    await waitForJson<{ marker: string }>(
      "the Lambda to serve lambda-v2",
      api("/aws/"),
      (body) => body.marker === "lambda-v2",
      { tries: 240, delayMs: 1_000, server },
    );

    server.assertAlive("lambda hot swap");
    // Bindings survived the swap.
    expect((await fetchJson<{ text: string }>(api("/aws/s3"))).text).toBe(
      "hello from s3",
    );
  },
  PHASE_TIMEOUT,
);

// ───────────────────────────────────────────────────────────────────────
// Phase 3 — files that move out from under the bundler.
// ───────────────────────────────────────────────────────────────────────

test(
  "surviving a moved module: the importer points at a missing path, then the file arrives",
  async () => {
    const importer = server.read("src/api-worker.ts");

    // Deliberately out of order: rewrite the import FIRST, so the bundler
    // is asked to resolve a module that does not exist yet.
    server.write(
      "src/api-worker.ts",
      importer.replace('"./api/message.ts"', '"./api/nested/message.ts"'),
    );
    await Bun.sleep(8_000);
    // A failed rebuild takes ITS worker off the air — that part is fine.
    // What must hold is that the dev server lives and every unrelated
    // resource is untouched.
    server.assertAlive("broken import window");
    expect(
      (await fetchJson<{ marker: string }>(echo("/marker"))).marker,
    ).toBe("echo-v2");
    expect(await (await fetchOk(awsSite("/"))).text()).toContain("aws-site-v1");

    // Complete the move, with a NEW value so "the rebuild happened" cannot
    // be confused with "the old bundle is still serving".
    server.remove("src/api/message.ts");
    server.write("src/api/nested/message.ts", messageModule("message-moved"));
    await waitForJson<{ message: string }>(
      "ApiWorker to rebuild against the moved module",
      api("/marker"),
      (body) => body.message === "message-moved",
      { tries: 180, delayMs: 500, server },
    );

    // The NEW path is watched too, not just resolved once.
    server.write("src/api/nested/message.ts", messageModule("message-v2"));
    await waitForJson<{ message: string }>(
      "the moved module's edit to land",
      api("/marker"),
      (body) => body.message === "message-v2",
      { server },
    );
    server.assertAlive("moved module reload");
  },
  PHASE_TIMEOUT,
);

// ───────────────────────────────────────────────────────────────────────
// Phase 4 — broken states. The dev server must log and wait, never exit.
// ───────────────────────────────────────────────────────────────────────

test(
  "surviving a syntax error in a stack-imported module",
  async () => {
    const plansBefore = server.planCount;
    const cursor = server.mark();
    // Unterminated string literal: the module cannot even be parsed, so
    // importing the stack throws before any Alchemy code runs.
    server.write("src/echo/marker.ts", 'export const ECHO_MARKER = "oops\n');

    await pollUntil(
      "the CLI to report the failed run",
      () =>
        /alchemy dev: run failed|SyntaxError|Unterminated|Unexpected end/.test(
          server.since(cursor),
        ) || undefined,
      { tries: 120, delayMs: 500, server },
    );
    server.assertAlive("stack syntax error");

    // EchoWorker is down (its bundle no longer builds), but every resource
    // that does not depend on the broken module keeps serving: they live in
    // the provider sidecar, which the exec child's crash does not touch.
    expect(
      (await fetchJson<{ marker: string }>(api("/marker"))).marker,
    ).toBe("api-v2");
    expect(await (await fetchOk(awsSite("/"))).text()).toContain("aws-site-v1");

    // Recovery on the next save.
    server.write("src/echo/marker.ts", markerModule("ECHO_MARKER", "echo-v3"));
    await waitForJson<{ marker: string }>(
      "EchoWorker to recover on echo-v3",
      echo("/marker"),
      (body) => body.marker === "echo-v3",
      { tries: 240, delayMs: 500, server },
    );
    await server.waitForPlanAfter(plansBefore);
    cleanCursor = server.mark();
  },
  PHASE_TIMEOUT,
);

test(
  "surviving a throw at module scope",
  async () => {
    const config = server.read("src/stack-config.ts");
    server.write(
      "src/stack-config.ts",
      `${config}\nthrow new Error("dev-stress: deliberate module-scope failure");\n`,
    );

    await pollUntil(
      "the CLI to report the failed run",
      () =>
        server.since(cleanCursor).includes("deliberate module-scope failure")
          ? true
          : undefined,
      { tries: 120, delayMs: 500, server },
    );
    server.assertAlive("module-scope throw");
    expect(server.since(cleanCursor)).toContain("alchemy dev: run failed");

    // Restore and converge.
    server.write("src/stack-config.ts", config);
    server.write("src/echo/marker.ts", markerModule("ECHO_MARKER", "echo-v4"));
    await waitForJson<{ marker: string }>(
      "EchoWorker to recover on echo-v4",
      echo("/marker"),
      (body) => body.marker === "echo-v4",
      { tries: 240, delayMs: 500, server },
    );
    cleanCursor = server.mark();
  },
  PHASE_TIMEOUT,
);

test(
  "surviving an apply failure: healthy resources keep serving while one resource cannot reconcile",
  async () => {
    // A second Worker that demands a port EchoWorker already holds. The
    // stack imports and plans fine; the reconcile is what fails — which is
    // the case that has to leave the rest of the stack serving. (A Worker
    // with a missing `main` is NOT such a case: the local provider creates
    // it happily.)
    server.write("src/extra/squatter.ts", portSquatterSource);
    server.patchRegion("alchemy.run.ts", "EXTRA", portSquatterDeclaration);

    await pollUntil(
      "the CLI to report the failed apply",
      () =>
        /alchemy dev: apply failed/.test(server.since(cleanCursor)) ||
        undefined,
      { tries: 240, delayMs: 500, server },
    );
    server.assertAlive("apply failure");
    expect(server.since(cleanCursor)).toContain("already in use");

    // Everything healthy is still healthy.
    expect(
      (await fetchJson<{ marker: string }>(echo("/marker"))).marker,
    ).toBe("echo-v4");
    expect(
      (await fetchJson<{ marker: string }>(api("/marker"))).marker,
    ).toBe("api-v2");
    expect((await fetchJson<{ text: string }>(api("/aws/s3"))).text).toBe(
      "hello from s3",
    );

    server.patchRegion("alchemy.run.ts", "EXTRA", "");
    server.remove("src/extra/squatter.ts");
    server.write("src/echo/marker.ts", markerModule("ECHO_MARKER", "echo-v5"));
    await waitForJson<{ marker: string }>(
      "the stack to converge again",
      echo("/marker"),
      (body) => body.marker === "echo-v5",
      { tries: 240, delayMs: 500, server },
    );
    cleanCursor = server.mark();
  },
  PHASE_TIMEOUT,
);

// ───────────────────────────────────────────────────────────────────────
// Phase 5 — the resource GRAPH changes shape. This is the substance of the
// suite: resources appear, get renamed, get replaced and disappear while
// the dev server keeps running, across both clouds and every resource kind
// the stack has (Workers, a Lambda, buckets, a queue + its event source, a
// Durable Object class, a MicroVM image).
// ───────────────────────────────────────────────────────────────────────

test(
  "graph churn: a Cloudflare Worker can be added, renamed onto a new port, and removed",
  async () => {
    // ── add ──
    server.write("src/extra/extra-worker.ts", extraWorkerSource("extra-v1"));
    server.patchRegion(
      "alchemy.run.ts",
      "EXTRA",
      extraWorkerDeclaration("ExtraWorker", "extra"),
    );
    server.patchRegion("alchemy.run.ts", "EXTRA_OUTPUTS", extraWorkerOutput);
    await waitForJson<{ marker: string }>(
      "the added ExtraWorker to serve",
      extra("/"),
      (body) => body.marker === "extra-v1",
      { tries: 240, delayMs: 500, server },
    );
    // The worker serves before the stack's re-apply prints its outputs —
    // the output line is the proof the ENGINE saw the new resource.
    await pollUntil(
      "extraUrl in the stack outputs",
      () => server.outputUrl("extraUrl"),
      { tries: 120, delayMs: 500, server },
    );
    server.assertAlive("worker added");

    // ── rename (a new logical id is a create + a delete) ──
    // The new generation lands on its own port: the engine may create
    // before it deletes, and two `strictPort` workers cannot share one.
    server.patchRegion(
      "alchemy.run.ts",
      "EXTRA",
      extraWorkerDeclaration("RenamedWorker", "extraAlt"),
    );
    server.write("src/extra/extra-worker.ts", extraWorkerSource("extra-v2"));
    await waitForJson<{ marker: string }>(
      "the renamed worker to serve on its new port",
      extraAlt("/"),
      (body) => body.marker === "extra-v2",
      { tries: 240, delayMs: 500, server },
    );
    // …and the old generation is gone.
    await pollUntil(
      "the old worker's port to stop serving",
      async () => ((await isClosed(extra("/"))) ? true : undefined),
      { tries: 120, delayMs: 500, server },
    );
    server.assertAlive("worker renamed");

    // ── remove (output reference first, so the stack never names a
    // binding that no longer exists) ──
    server.patchRegion("alchemy.run.ts", "EXTRA_OUTPUTS", "");
    server.patchRegion("alchemy.run.ts", "EXTRA", "");
    server.remove("src/extra/extra-worker.ts");
    await pollUntil(
      "the removed worker to stop serving",
      async () =>
        (await stoppedServing(extraAlt("/"), "extra-v2")) ? true : undefined,
      { tries: 240, delayMs: 500, server },
    );
    server.assertAlive("worker removed");

    // The survivors are untouched.
    expect(
      (await fetchJson<{ marker: string }>(echo("/marker"))).marker,
    ).toBe("echo-v5");
    cleanCursor = server.mark();
  },
  PHASE_TIMEOUT,
);

test(
  "graph churn: a whole AWS Lambda (with its own S3 bucket) can be added and removed",
  async () => {
    // ── add: a new module, a new top-level import in the stack, a new
    // Function resource, a new Bucket resource, and two new bindings ──
    server.write(
      "src/extra/ReportFunction.ts",
      reportFunctionSource("report-v1"),
    );
    server.patchRegion("alchemy.run.ts", "EXTRA_IMPORTS", reportFunctionImport);
    server.patchRegion("alchemy.run.ts", "EXTRA", reportFunctionDeclaration);
    server.patchRegion("alchemy.run.ts", "EXTRA_OUTPUTS", reportFunctionOutput);

    const reportUrl = await pollUntil(
      "the new Lambda's function URL in the stack outputs",
      () => server.outputUrl("reportUrl"),
      { tries: 480, delayMs: 500, server },
    );
    // Local identity: a floci URL, never real AWS.
    expect(reportUrl).toContain("localhost:4566");

    const report = await fetchJson<{ marker: string; text: string }>(
      new URL("/report", reportUrl),
      undefined,
      { tries: 240, delayMs: 500 },
    );
    expect(report).toEqual({ marker: "report-v1", text: "report-v1" });
    server.assertAlive("lambda added");

    // ── change it: a new marker means a new bundle for a Function that
    // only came into existence a moment ago ──
    server.write(
      "src/extra/ReportFunction.ts",
      reportFunctionSource("report-v2"),
    );
    await waitForJson<{ marker: string }>(
      "the added Lambda to hot-swap to report-v2",
      new URL("/report", reportUrl),
      (body) => body.marker === "report-v2",
      { tries: 480, delayMs: 500, server },
    );

    // ── remove: the Function, its Bucket and its URL all go away ──
    server.patchRegion("alchemy.run.ts", "EXTRA_OUTPUTS", "");
    server.patchRegion("alchemy.run.ts", "EXTRA", "");
    server.patchRegion("alchemy.run.ts", "EXTRA_IMPORTS", "");
    server.remove("src/extra/ReportFunction.ts");
    await pollUntil(
      "the removed Lambda to stop answering",
      async () => {
        try {
          const res = await fetch(new URL("/report", reportUrl), {
            signal: AbortSignal.timeout(5_000),
          });
          return res.ok ? undefined : true;
        } catch {
          return true;
        }
      },
      { tries: 240, delayMs: 500, server },
    );
    server.assertAlive("lambda removed");

    // The original Lambda is untouched by its sibling's whole lifecycle.
    expect((await fetchJson<{ text: string }>(api("/aws/s3"))).text).toBe(
      "hello from s3",
    );
    cleanCursor = server.mark();
  },
  PHASE_TIMEOUT,
);

test(
  "graph churn: a Queue, its consumer event source, and a new Durable Object class are grafted onto a LIVE Worker",
  async () => {
    const plansBefore = server.planCount;

    // Three kinds of change at once, all on a Worker that is already
    // serving: a new resource (the Queue), a new event source (its
    // consumer), and a new Durable Object class — which means a class
    // migration on a running script.
    server.patchRegion("src/EchoWorker.ts", "ECHO_IMPORTS", echoStreamImport);
    server.patchRegion("src/EchoWorker.ts", "ECHO_BINDINGS", echoQueueBindings);
    server.patchRegion("src/EchoWorker.ts", "ECHO_ROUTES", echoQueueRoutes);
    server.patchRegion("src/EchoWorker.ts", "ECHO_LAYERS", echoQueueLayers);
    server.patchRegion("src/EchoWorker.ts", "ECHO_CLASSES", echoInboxClass);

    // The bundler hot-swaps the new script BEFORE the stack re-apply has
    // registered the `Inbox` class and the queue consumer, so for a beat
    // the Worker serves a bundle whose DO binding workerd rejects
    // (`DurableObject 'Inbox' not found`). A message sent in that window
    // has no consumer and is lost. Wait for the re-apply to land first;
    // the self-healing is what's under test, not the window.
    await server.waitForPlanAfter(plansBefore, { tries: 480 });
    await pollUntil(
      "the re-apply that registers the Queue, consumer and DO to finish",
      () =>
        /\[EchoQueueConsumer\] created/.test(server.since(cleanCursor))
          ? true
          : undefined,
      { tries: 480, delayMs: 500, server },
    );

    const id = crypto.randomUUID();
    await pollUntil(
      "the new queue route to accept a message",
      async () => {
        try {
          const res = await fetch(echo(`/queue/send?id=${id}`), {
            signal: AbortSignal.timeout(5_000),
          });
          return res.ok ? true : undefined;
        } catch {
          return undefined;
        }
      },
      { tries: 480, delayMs: 500, server },
    );

    // Produce → the local broker delivers → the new DO records it.
    const received = await waitForJson<{ ids: string[] }>(
      "the queue message to reach the new Durable Object",
      echo("/queue/received"),
      (body) => body.ids.includes(id),
      { tries: 240, delayMs: 500, server },
    );
    expect(received.ids).toContain(id);
    server.assertAlive("queue + consumer + DO added");

    // The Worker's pre-existing bindings still work after the graft.
    expect((await fetchJson<{ value: string }>(echo("/kv?key=graft"))).value)
      .toBe("kv:graft");
    expect(
      (await fetchJson<{ count: number }>(echo("/counter"))).count,
    ).toBeGreaterThan(0);

    // ── and back out again: the routes, the consumer, the Queue and the
    // DO class all disappear from a running Worker ──
    server.patchRegion("src/EchoWorker.ts", "ECHO_ROUTES", "");
    server.patchRegion("src/EchoWorker.ts", "ECHO_BINDINGS", "");
    server.patchRegion("src/EchoWorker.ts", "ECHO_LAYERS", "");
    server.patchRegion("src/EchoWorker.ts", "ECHO_CLASSES", "");
    server.patchRegion("src/EchoWorker.ts", "ECHO_IMPORTS", "");
    await pollUntil(
      "the queue route to disappear",
      async () => {
        try {
          const res = await fetch(echo(`/queue/send?id=${id}`), {
            signal: AbortSignal.timeout(5_000),
          });
          // The fall-through route answers with the marker instead.
          if (!res.ok) return true;
          const body = (await res.json()) as { sent?: string };
          return body.sent === undefined ? true : undefined;
        } catch {
          return undefined;
        }
      },
      { tries: 480, delayMs: 500, server },
    );
    server.assertAlive("queue + consumer + DO removed");
    expect(
      (await fetchJson<{ marker: string }>(echo("/marker"))).marker,
    ).toBe("echo-v5");
    cleanCursor = server.mark();
  },
  PHASE_TIMEOUT,
);

test(
  "graph churn: a second S3 bucket and its bindings are added to the LIVE Lambda, then removed",
  async () => {
    server.patchRegion(
      "src/ApiFunction.ts",
      "LAMBDA_BINDINGS",
      lambdaArchiveBindings,
    );
    server.patchRegion(
      "src/ApiFunction.ts",
      "LAMBDA_ROUTES",
      lambdaArchiveRoutes,
    );

    // Driven through the cross-cloud hop, so this also re-proves the
    // Worker → Lambda edge after the Lambda's binding set changed.
    const archived = await waitForJson<{ text: string }>(
      "the new bucket binding to answer on the Lambda",
      api("/aws/archive"),
      (body) => body.text === "archived",
      { tries: 480, delayMs: 500, server },
    );
    expect(archived.text).toBe("archived");
    server.assertAlive("lambda bucket added");

    // Pre-existing bindings survived the change.
    expect((await fetchJson<{ text: string }>(api("/aws/dynamo"))).text).toBe(
      "hello from dynamo",
    );
    // The engine just UPDATED the Function — hot swap must still work.
    await expectLambdaHotSwapStillWorks("archive-added");

    server.patchRegion("src/ApiFunction.ts", "LAMBDA_ROUTES", "");
    server.patchRegion("src/ApiFunction.ts", "LAMBDA_BINDINGS", "");
    await pollUntil(
      "the archive route to disappear",
      async () => {
        try {
          const res = await fetch(api("/aws/archive"), {
            signal: AbortSignal.timeout(10_000),
          });
          return res.status === 404 ? true : undefined;
        } catch {
          return undefined;
        }
      },
      { tries: 480, delayMs: 500, server },
    );
    server.assertAlive("lambda bucket removed");
    await expectLambdaHotSwapStillWorks("archive-removed");
    cleanCursor = server.mark();
  },
  PHASE_TIMEOUT,
);

test(
  "ECS hot reload: context content, the Dockerfile itself, an env prop, and an inline-Dockerfile prop all roll the running containers",
  async () => {
    // ── 1. a file in the build context (the classic watch path) ──
    server.write("site/ecs/index.html", "ecs-site-v2\n");
    await waitForText(
      "the ECS service to serve the edited context file",
      ecs("/"),
      "ecs-site-v2",
    );
    server.assertAlive("ecs context reload");

    // ── 2. the Dockerfile ITSELF (also a file in the context, but the
    // change only lands if the image actually rebuilds) ──
    server.write(
      "site/ecs/Dockerfile",
      server
        .read("site/ecs/Dockerfile")
        .replace("BAKED_MARKER=dockerfile-v1", "BAKED_MARKER=dockerfile-v2"),
    );
    await waitForText(
      "the ECS service to serve the rebuilt Dockerfile marker",
      ecs("/baked.txt"),
      "dockerfile-v2",
    );
    // The context file survived the rebuild.
    await waitForText(
      "the context file to still serve after the Dockerfile rebuild",
      ecs("/"),
      "ecs-site-v2",
    );
    server.assertAlive("ecs dockerfile reload");

    // ── 3. an env PROP (no file event at all — the engine registers a new
    // task-definition revision, and the running task must roll onto it;
    // regression: only file-watch triggers restarted tasks, so prop-driven
    // updates left containers serving the old revision forever) ──
    server.patchRegion(
      "alchemy.run.ts",
      "ECS_ENV",
      '        STRESS_ENV: "ecs-env-v2",\n',
    );
    await waitForText(
      "the ECS task to roll onto the new env",
      ecs("/env.txt"),
      "ecs-env-v2",
    );
    server.assertAlive("ecs env-prop reload");

    // ── 4. an INLINE Dockerfile (a pure prop change that is nonetheless a
    // Dockerfile edit — same engine path as 3, but the image itself must
    // rebuild) ──
    server.patchRegion(
      "alchemy.run.ts",
      "ECS_INLINE_MARKER",
      `          "RUN mkdir -p /www && echo -n ecs-inline-v2 > /www/index.html",\n`,
    );
    await waitForText(
      "the inline-Dockerfile service to serve the rebuilt image",
      ecsInline("/"),
      "ecs-inline-v2",
    );
    server.assertAlive("ecs inline-dockerfile reload");

    // The sibling service was untouched by the inline rebuild.
    await waitForText(
      "the context service to still serve",
      ecs("/"),
      "ecs-site-v2",
      { tries: 30 },
    );
    cleanCursor = server.mark();
  },
  PHASE_TIMEOUT,
);

test(
  "EC2 hot reload: the hosted instance serves, and editing its program updates it in place",
  async () => {
    // The box's address comes from floci: `i-….localhost.floci.io`
    // resolves to 127.0.0.1 and the mux publishes the SG app port.
    const dns = await pollUntil(
      "ec2Dns in the stack outputs",
      () => server.outputValue("ec2Dns"),
      { tries: 240, delayMs: 500, server },
    );
    expect(dns).toMatch(/\.localhost\.floci\.io$/);
    const marker = at2(dns, PORTS.ec2, "/marker");

    // First boot: container start + userData (bundle sync from emulated
    // S3, runtime install) + the Bun HTTP server binding the app port.
    await waitForJson<{ marker: string }>(
      "the EC2 box to serve its hosted program",
      marker,
      (body) => body.marker === "ec2-v1",
      { tries: 90, delayMs: 1_000, server },
    );

    // The reload path is the ENGINE's: a content edit re-plans, the
    // provider re-uploads the bundle in place and reboots the instance —
    // same instance id, same address, new code.
    const reloadStartedAt = Date.now();
    server.write("src/ec2/marker.ts", markerModule("EC2_MARKER", "ec2-v2"));
    await waitForJson<{ marker: string }>(
      "the EC2 box to serve ec2-v2 after the in-place update",
      marker,
      (body) => body.marker === "ec2-v2",
      { tries: 150, delayMs: 1_000, server },
    );
    console.log(
      `ec2 hosted-program reload -> serving ec2-v2 in ${Date.now() - reloadStartedAt}ms`,
    );
    // Same box, same address — the update was in place, not a replacement.
    expect(server.outputValue("ec2Dns")).toBe(dns);
    server.assertAlive("ec2 hot reload");
  },
  PHASE_TIMEOUT,
);

test(
  "Cloudflare Container hot reload: editing the container's program rebuilds the image and restarts it",
  async () => {
    // The container module is imported by the stack, so this edit replans;
    // the reload rides the image content hash in the worker's restart
    // config (regression: the sidecar-lifetime artifact memo made the diff
    // compare the first run's hash forever, and the config only carried
    // the image's stable paths — the running container served stale code
    // until a full dev-session restart).
    server.patchRegion(
      "src/SandboxContainer.ts",
      "SANDBOX_MARKER",
      '          marker: "sandbox-v2",\n',
    );
    await waitForJson<{ marker: string }>(
      "the sandbox container to serve the rebuilt program",
      echo("/sandbox"),
      (body) => body.marker === "sandbox-v2",
      { tries: 300, delayMs: 1_000, server },
    );
    server.assertAlive("container hot reload");

    // The #1334 loopback rewrite still holds on the rebuilt container.
    const hostFetch = await fetchJson<{ body: string }>(
      echo("/sandbox/host-fetch"),
      undefined,
      { tries: 60, delayMs: 1_000 },
    );
    expect(hostFetch.body).toContain("aws-site-env-v1");
    cleanCursor = server.mark();
  },
  PHASE_TIMEOUT,
);

test(
  "graph churn: a replacement-forcing prop change swaps a DynamoDB table under a running Lambda",
  async () => {
    const source = server.read("src/ApiFunction.ts");
    // The partition key is immutable on DynamoDB — changing it is a
    // REPLACEMENT, not an update: a new table is created, the Lambda's
    // binding is repointed, and the old table is deleted.
    server.write(
      "src/ApiFunction.ts",
      source
        .replace('partitionKey: "id",', 'partitionKey: "pk",')
        .replace('attributes: { id: "S" },', 'attributes: { pk: "S" },')
        // every item key in the handler, in one sweep
        .replaceAll("id: { S:", "pk: { S:"),
    );

    // The old table answers `/dynamo` until the replacement lands, so the
    // engine's own plan line is the signal — then the route must work
    // against the NEW table (a fresh write lands in it).
    const replacedCursor = server.mark();
    await pollUntil(
      "the engine to plan the table replacement",
      () =>
        /\[StressTable\] replace/.test(server.plain(replacedCursor)) ||
        undefined,
      { tries: 240, delayMs: 500, server },
    );
    // A replacement prints `creating replacement` → `created` and then
    // cleans up the old generation; the cleanup line is the end of it.
    await pollUntil(
      "the replaced table to finish",
      () =>
        /\[StressTable\] Replaced resource cleanup complete/.test(
          server.plain(replacedCursor),
        ) || undefined,
      { tries: 480, delayMs: 500, server },
    );
    await waitForJson<{ text: string }>(
      "the replaced table to serve through the Lambda",
      api("/aws/dynamo"),
      (body) => body.text === "hello from dynamo",
      { tries: 480, delayMs: 500, server },
    );
    server.assertAlive("table replaced");
    await expectLambdaHotSwapStillWorks("table-replaced");

    // Put it back — the swap back is a second replacement.
    const restoredCursor = server.mark();
    server.write("src/ApiFunction.ts", source);
    await pollUntil(
      "the table's second replacement to finish",
      () =>
        /\[StressTable\] Replaced resource cleanup complete/.test(
          server.plain(restoredCursor),
        ) || undefined,
      { tries: 480, delayMs: 500, server },
    );
    await waitForJson<{ text: string }>(
      "the restored table to serve through the Lambda",
      api("/aws/dynamo"),
      (body) => body.text === "hello from dynamo",
      { tries: 480, delayMs: 500, server },
    );
    server.assertAlive("table restored");
    await expectLambdaHotSwapStillWorks("table-restored");
    cleanCursor = server.mark();
  },
  PHASE_TIMEOUT,
);

test(
  "graph churn: a SECOND AWS MicroVM image is added, driven from the Worker, and removed",
  async () => {
    // A new image resource (floci builds it), a new top-level import in
    // both the stack and the Worker, two new MicroVM bindings on a running
    // Worker, and a route that boots and terminates an instance of it.
    server.write("src/extra/WorkerImage.ts", secondImageSource("worker-vm-v1"));
    server.patchRegion("alchemy.run.ts", "EXTRA_IMPORTS", secondImageImport);
    server.patchRegion("alchemy.run.ts", "EXTRA_LAYERS", secondImageLayer);
    server.patchRegion(
      "src/MicrovmWorker.ts",
      "VM_IMPORTS",
      secondImageWorkerImport,
    );
    server.patchRegion(
      "src/MicrovmWorker.ts",
      "VM_BINDINGS",
      secondImageBindings,
    );
    server.patchRegion("src/MicrovmWorker.ts", "VM_ROUTES", secondImageRoutes);

    const booted = await waitForJson<{ microvmId: string }>(
      "the second MicroVM image to build and boot an instance",
      microvm("/second"),
      (body) => typeof body.microvmId === "string" && body.microvmId.length > 0,
      { tries: 900, delayMs: 1_000, server },
    );
    expect(booted.microvmId).toBeTruthy();
    server.assertAlive("second microvm added");

    // The FIRST image still works — adding a sibling did not disturb it.
    expect(
      (
        await fetchJson<{ marker: string }>(
          microvm("/roundtrip?message=sibling"),
          undefined,
          { tries: 300, delayMs: 1_000 },
        )
      ).marker,
    ).toBe("vm-v1");

    // ── remove the second image and everything that referenced it ──
    server.patchRegion("src/MicrovmWorker.ts", "VM_ROUTES", "");
    server.patchRegion("src/MicrovmWorker.ts", "VM_BINDINGS", "");
    server.patchRegion("src/MicrovmWorker.ts", "VM_IMPORTS", "");
    server.patchRegion("alchemy.run.ts", "EXTRA_LAYERS", "");
    server.patchRegion("alchemy.run.ts", "EXTRA_IMPORTS", "");
    server.remove("src/extra/WorkerImage.ts");
    await pollUntil(
      "the second MicroVM's route to disappear",
      async () => {
        try {
          const res = await fetch(microvm("/second"), {
            signal: AbortSignal.timeout(10_000),
          });
          const text = await res.text();
          return text === "ok" ? true : undefined;
        } catch {
          return undefined;
        }
      },
      { tries: 600, delayMs: 500, server },
    );
    server.assertAlive("second microvm removed");
    cleanCursor = server.mark();
  },
  PHASE_TIMEOUT,
);

test(
  "graph churn: the entire AWS Lambda subsystem is deleted and restored while Cloudflare keeps serving",
  async () => {
    const awsHalf = server.read("alchemy.run.ts");

    // Delete the Lambda, its bucket, its table, its queue and its event
    // source in one edit — and the cross-cloud binding that referenced it.
    server.patchRegion("alchemy.run.ts", "AWS_OUTPUTS", "");
    server.patchRegion("alchemy.run.ts", "AWS_LAMBDA_URL", "");
    server.patchRegion("alchemy.run.ts", "AWS_HALF", "");

    await pollUntil(
      "the AWS half to be gone from ApiWorker's bindings",
      async () => {
        try {
          const body = (await (
            await fetch(api("/env"), { signal: AbortSignal.timeout(5_000) })
          ).json()) as { AWS_LAMBDA_URL: string | null };
          return body.AWS_LAMBDA_URL === null ? true : undefined;
        } catch {
          return undefined;
        }
      },
      { tries: 600, delayMs: 500, server },
    );
    server.assertAlive("aws half deleted");

    // Cloudflare is completely unaffected by the AWS half vanishing.
    expect(
      (await fetchJson<{ marker: string }>(echo("/marker"))).marker,
    ).toBe("echo-v5");
    expect((await fetchJson<{ text: string }>(echo("/r2"))).text).toBe(
      "hello from r2",
    );
    expect(await (await fetchOk(awsSite("/"))).text()).toContain("aws-site-v1");

    // ── restore the whole subsystem ──
    server.write("alchemy.run.ts", awsHalf);
    await waitForJson<{ marker: string }>(
      "the restored Lambda to serve through the cross-cloud hop",
      api("/aws/"),
      (body) => body.marker.startsWith("lambda-"),
      { tries: 900, delayMs: 500, server },
    );
    expect((await fetchJson<{ text: string }>(api("/aws/s3"))).text).toBe(
      "hello from s3",
    );
    server.assertAlive("aws half restored");
    // A brand-new Function generation must get a working watch loop.
    await expectLambdaHotSwapStillWorks("aws-half-restored");
    cleanCursor = server.mark();
  },
  PHASE_TIMEOUT,
);

test(
  "binding churn: changing a binding value re-applies the consumer; changing a dev child's env restarts it",
  async () => {
    // A plain var binding on the path-`main` Worker.
    server.patchRegion(
      "alchemy.run.ts",
      "API_VARIABLE",
      '        API_VARIABLE: "api-variable-v2",\n',
    );
    await waitForJson<{ API_VARIABLE: string }>(
      "ApiWorker to pick up the new binding value",
      api("/env"),
      (body) => body.API_VARIABLE === "api-variable-v2",
      { tries: 240, delayMs: 500, server },
    );

    // A brand-new binding on a Worker that is already running.
    server.patchRegion(
      "alchemy.run.ts",
      "API_EXTRA_ENV",
      '        API_EXTRA: "api-extra-v1",\n',
    );
    await waitForJson<{ API_EXTRA: string | null }>(
      "ApiWorker to gain a binding it never had",
      api("/env"),
      (body) => body.API_EXTRA === "api-extra-v1",
      { tries: 240, delayMs: 500, server },
    );

    // …and lose it again.
    server.patchRegion("alchemy.run.ts", "API_EXTRA_ENV", "");
    await waitForJson<{ API_EXTRA: string | null }>(
      "ApiWorker to lose the binding again",
      api("/env"),
      (body) => body.API_EXTRA === null,
      { tries: 240, delayMs: 500, server },
    );

    // `Command.Dev`'s restart surface: a change to the resolved config must
    // restart the child (new pid), not silently leave the old one running.
    const pidBefore = (await fetchJson<{ pid: number }>(awsSite("/__dev-env")))
      .pid;
    server.patchRegion(
      "alchemy.run.ts",
      "SITE_MARKER",
      '          SITE_MARKER: "aws-site-env-v2",\n',
    );
    const restarted = await waitForJson<{ marker: string; pid: number }>(
      "the dev-command child to restart with the new env",
      awsSite("/__dev-env"),
      (body) => body.marker === "aws-site-env-v2",
      { tries: 240, delayMs: 500, server },
    );
    expect(restarted.pid).not.toBe(pidBefore);
    server.assertAlive("binding churn");
    await expectLambdaHotSwapStillWorks("binding-churn");
    cleanCursor = server.mark();
  },
  PHASE_TIMEOUT,
);

// ───────────────────────────────────────────────────────────────────────
// Phase 6 — rapid-fire edits. Convergence to the LAST write, and evidence
// that the watchers coalesce instead of replaying every keystroke.
// ───────────────────────────────────────────────────────────────────────

test(
  "rapid-fire bundler edits converge on the last write without re-running the stack",
  async () => {
    // The previous phase edited stack-graph files (alchemy.run.ts, the
    // Lambda source); absorb any trailing re-plan before baselining.
    await server.settlePlans();
    const plansBefore = server.planCount;
    const BURST = 25;
    for (let i = 1; i <= BURST; i++) {
      server.write(
        "src/api/marker.ts",
        markerModule("API_MARKER", `api-storm-${i}`),
      );
      await Bun.sleep(40);
    }

    await waitForJson<{ marker: string }>(
      `ApiWorker to settle on api-storm-${BURST}`,
      api("/marker"),
      (body) => body.marker === `api-storm-${BURST}`,
      { tries: 240, delayMs: 500, server },
    );
    // A burst on the bundler path must never escalate into stack re-runs.
    expect(server.planCount).toBe(plansBefore);
    server.assertAlive("bundler burst");
  },
  PHASE_TIMEOUT,
);

test(
  "rapid-fire stack edits converge on the last write and are coalesced",
  async () => {
    const plansBefore = server.planCount;
    const BURST = 15;
    for (let i = 1; i <= BURST; i++) {
      server.write(
        "src/echo/marker.ts",
        markerModule("ECHO_MARKER", `echo-storm-${i}`),
      );
      await Bun.sleep(60);
    }

    await waitForJson<{ marker: string }>(
      `EchoWorker to settle on echo-storm-${BURST}`,
      echo("/marker"),
      (body) => body.marker === `echo-storm-${BURST}`,
      { tries: 360, delayMs: 500, server },
    );

    // The hot swap lands before the stack re-runs; wait for the re-plan
    // and let any coalesced follow-up runs drain before counting.
    await server.waitForPlanAfter(plansBefore);
    await Bun.sleep(15_000);
    const restarts = server.planCount - plansBefore;
    expect(restarts).toBeGreaterThanOrEqual(1);
    // Debouncing: a sub-second burst of 15 saves must not produce 15
    // complete plan/apply cycles.
    expect(restarts).toBeLessThan(BURST);
    server.assertAlive("stack burst");
  },
  PHASE_TIMEOUT,
);

test(
  "simultaneous cross-cloud edits all land",
  async () => {
    // One tick, four surfaces: the bundler path, the watch path, the AWS
    // half, and the stack graph itself.
    server.write("src/api/marker.ts", markerModule("API_MARKER", "api-final"));
    server.write("src/echo/marker.ts", markerModule("ECHO_MARKER", "echo-final"));
    server.write(
      "src/lambda/marker.ts",
      markerModule("LAMBDA_MARKER", "lambda-final"),
    );
    server.patchRegion(
      "alchemy.run.ts",
      "API_VARIABLE",
      '        API_VARIABLE: "api-variable-final",\n',
    );

    await waitForJson<{ marker: string }>(
      "EchoWorker to serve echo-final",
      echo("/marker"),
      (body) => body.marker === "echo-final",
      { tries: 360, delayMs: 500, server },
    );
    await waitForJson<{ marker: string }>(
      "ApiWorker to serve api-final",
      api("/marker"),
      (body) => body.marker === "api-final",
      { tries: 360, delayMs: 500, server },
    );
    await waitForJson<{ API_VARIABLE: string }>(
      "ApiWorker to carry api-variable-final",
      api("/env"),
      (body) => body.API_VARIABLE === "api-variable-final",
      { tries: 360, delayMs: 500, server },
    );
    await waitForJson<{ marker: string }>(
      "the Lambda to serve lambda-final",
      api("/aws/"),
      (body) => body.marker === "lambda-final",
      { tries: 360, delayMs: 1_000, server },
    );
    server.assertAlive("simultaneous edits");
  },
  PHASE_TIMEOUT,
);

// ───────────────────────────────────────────────────────────────────────
// Phase 7 — after all that churn, the whole stack is still the stack.
// ───────────────────────────────────────────────────────────────────────

test(
  "after the full churn every resource still serves and the CLI never restarted",
  async () => {
    server.assertAlive("final health check");

    // Cloudflare
    expect((await fetchJson<{ value: string }>(echo("/kv?key=final"))).value)
      .toBe("kv:final");
    expect((await fetchJson<{ text: string }>(echo("/r2"))).text).toBe(
      "hello from r2",
    );
    expect(
      (await fetchJson<{ count: number }>(echo("/counter"))).count,
    ).toBeGreaterThan(0);
    const finalSandbox = await fetchJson<{ greeting: string; marker: string }>(
      echo("/sandbox"),
      undefined,
      { tries: 60, delayMs: 1_000 },
    );
    expect(finalSandbox.greeting).toBe("hello-from-container");
    expect(finalSandbox.marker).toBe("sandbox-v2");

    // AWS, through the cross-cloud hop
    expect((await fetchJson<{ text: string }>(api("/aws/dynamo"))).text).toBe(
      "hello from dynamo",
    );
    const message = { id: crypto.randomUUID() };
    await fetchOk(api("/aws/queue/send"), {
      method: "POST",
      body: JSON.stringify(message),
    });
    const delivered = await waitForJson<{ body: string | null }>(
      "the post-churn queue message to be consumed",
      api(`/aws/queue/messages?id=${message.id}`),
      (body) => body.body !== null,
      { tries: 180, delayMs: 500, server },
    );
    expect(JSON.parse(delivered.body!)).toEqual(message);

    // ECS: both services still serve after every reload they went through.
    await waitForText("the ECS service post-churn", ecs("/"), "ecs-site-v2", {
      tries: 60,
    });
    await waitForText(
      "the inline ECS service post-churn",
      ecsInline("/"),
      "ecs-inline-v2",
      { tries: 60 },
    );

    // Websites. The Cloudflare site's port is not pinned (a
    // `Website.StaticSite` owns its Worker's dev options), so re-read the
    // newest value the CLI printed rather than trusting the boot one.
    expect(await (await fetchOk(awsSite("/"))).text()).toContain("aws-site-v1");
    cfSiteUrl = server.outputUrl("cfSiteUrl") ?? cfSiteUrl;
    expect(await (await fetchOk(new URL("/", cfSiteUrl))).text()).toContain(
      "cf-site-v1",
    );

    // No failure was logged since the last phase that expected one.
    expect(server.since(cleanCursor)).not.toContain("alchemy dev: run failed");
    expect(server.since(cleanCursor)).not.toContain(
      "alchemy dev: apply failed",
    );
  },
  PHASE_TIMEOUT,
);

test(
  "the MicroVM image survives every unrelated edit, and rebuilds when its own source changes",
  async () => {
    // Nothing the suite did to the other resources touched the image.
    expect(server.output).not.toContain("[StressMicrovm] replace");
    expect(
      (
        await fetchJson<{ marker: string }>(
          microvm("/roundtrip?message=post-churn"),
          undefined,
          { tries: 240, delayMs: 1_000 },
        )
      ).marker,
    ).toBe("vm-v1");

    // Now change the program that runs INSIDE the VM. The dev provider
    // builds the new image with a HOST-side cached `docker build` and hands
    // floci a pre-built `docker://` reference, so the rebuild itself is
    // seconds — the wait below is dominated by the roundtrip's own
    // boot-a-VM-per-request cost.
    const rebuildStartedAt = Date.now();
    server.write("src/vm/marker.ts", markerModule("VM_MARKER", "vm-v2"));
    await waitForJson<{ marker: string }>(
      "the rebuilt MicroVM image to serve vm-v2",
      microvm("/roundtrip?message=rebuild"),
      (body) => body.marker === "vm-v2",
      { tries: 600, delayMs: 1_000, server },
    );
    const rebuildMs = Date.now() - rebuildStartedAt;
    console.log(`microvm image rebuild -> serving vm-v2 in ${rebuildMs}ms`);
    // Pre-docker:// this took minutes (zip upload + cold server-side
    // build); the cached host build must keep the whole edit-to-serving
    // path within a couple of VM boots.
    expect(rebuildMs).toBeLessThan(120_000);
    server.assertAlive("microvm image rebuild");
  },
  PHASE_TIMEOUT,
);

test(
  "shuts down cleanly on Ctrl-C and stops serving",
  async () => {
    await server.shutdown();
    expect(server.alive).toBe(false);

    for (const url of [echo("/marker"), api("/marker"), awsSite("/")]) {
      await pollUntil(
        `${url} to stop serving after shutdown`,
        async () => ((await isClosed(url)) ? true : undefined),
        { tries: 60, delayMs: 500 },
      );
    }
  },
  PHASE_TIMEOUT,
);
