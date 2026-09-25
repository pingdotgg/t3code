/**
 * The source fragments the stress suite splices into the fixture's
 * `<<REGION>>` markers.
 *
 * These are the substance of the suite: each one is a real change to the
 * RESOURCE GRAPH — a new Lambda with its own bucket, a Queue plus its
 * consumer event source, a new Durable Object class (and therefore a class
 * migration) grafted onto a running Worker, a replacement-forcing schema
 * change, a second MicroVM image. Keeping them here as named constants
 * keeps the test file about *what is asserted* rather than about TypeScript
 * embedded in string literals.
 *
 * Indentation matters: `patchRegion` splices these between markers that sit
 * at a fixed depth in the fixture, so every fragment is written at the
 * depth its region lives at.
 */

// ─── An entire extra Cloudflare Worker (add / rename / remove) ──────────

export const extraWorkerSource = (marker: string) =>
  `export default {\n` +
  `  fetch: async () => Response.json({ marker: ${JSON.stringify(marker)} }),\n` +
  `};\n`;

export const extraWorkerDeclaration = (
  logicalId: string,
  port: "extra" | "extraAlt",
) =>
  `    const extraWorker = yield* Cloudflare.Worker(${JSON.stringify(logicalId)}, {\n` +
  `      main: "./src/extra/extra-worker.ts",\n` +
  `      dev: { port: PORTS.${port}, strictPort: true },\n` +
  `    });\n`;

export const extraWorkerOutput = "      extraUrl: extraWorker.url,\n";

// ─── A Worker that demands a port another Worker already holds ─────────
// The cleanest deterministic APPLY failure available locally: the stack
// imports and plans fine and exactly one resource cannot reconcile.

export const portSquatterSource =
  `export default { fetch: async () => new Response("squatter") };\n`;

export const portSquatterDeclaration =
  `    yield* Cloudflare.Worker("PortSquatter", {\n` +
  `      main: "./src/extra/squatter.ts",\n` +
  `      dev: { port: PORTS.echo, strictPort: true },\n` +
  `    });\n`;

// ─── An entire extra AWS Lambda, with its own S3 bucket ────────────────

export const reportFunctionSource = (marker: string) =>
  `import * as Lambda from "alchemy/AWS/Lambda";\n` +
  `import * as S3 from "alchemy/AWS/S3";\n` +
  `import * as Effect from "effect/Effect";\n` +
  `import * as Layer from "effect/Layer";\n` +
  `import * as Stream from "effect/Stream";\n` +
  `import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";\n` +
  `import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";\n` +
  `\n` +
  `/** Added to (and later removed from) the stack while dev is running. */\n` +
  `export default class ReportFunction extends Lambda.Function<ReportFunction>()(\n` +
  `  "ReportFunction",\n` +
  `  { main: import.meta.url, functionUrl: true, memorySize: 256 },\n` +
  `  Effect.gen(function* () {\n` +
  `    const bucket = yield* S3.Bucket("ReportBucket", { forceDestroy: true });\n` +
  `    const putObject = yield* S3.PutObject(bucket);\n` +
  `    const getObject = yield* S3.GetObject(bucket);\n` +
  `    return {\n` +
  `      fetch: Effect.gen(function* () {\n` +
  `        const request = yield* HttpServerRequest;\n` +
  `        const url = new URL(request.originalUrl);\n` +
  `        if (url.pathname === "/report") {\n` +
  `          yield* putObject({ Key: "report.txt", Body: ${JSON.stringify(marker)} });\n` +
  `          const object = yield* getObject({ Key: "report.txt" });\n` +
  `          const text = yield* (\n` +
  `            object.Body?.pipe(Stream.decodeText, Stream.mkString) ??\n` +
  `              Effect.succeed("")\n` +
  `          );\n` +
  `          return yield* HttpServerResponse.json({ marker: ${JSON.stringify(marker)}, text });\n` +
  `        }\n` +
  `        return HttpServerResponse.text("not found", { status: 404 });\n` +
  `      }).pipe(Effect.orDie),\n` +
  `    };\n` +
  `  }).pipe(Effect.provide(Layer.mergeAll(S3.GetObjectHttp, S3.PutObjectHttp))),\n` +
  `) {}\n`;

export const reportFunctionImport =
  `import ReportFunction from "./src/extra/ReportFunction.ts";\n`;

export const reportFunctionDeclaration =
  `    const reportFunction = yield* ReportFunction;\n`;

export const reportFunctionOutput =
  "      reportUrl: reportFunction.functionUrl,\n";

// ─── A Queue + its consumer + a new Durable Object class, grafted onto
// the already-running EchoWorker. This adds a resource, an event source,
// AND a class migration to a live Worker. ──────────────────────────────

export const echoQueueBindings =
  `    const echoQueue = yield* Cloudflare.Queues.Queue("EchoQueue");\n` +
  `    const echoQueueSend = yield* Cloudflare.Queues.WriteQueue(echoQueue);\n` +
  `    const inbox = yield* Inbox;\n` +
  `    yield* Cloudflare.Queues.consumeQueueMessages<{ id: string }>(\n` +
  `      echoQueue,\n` +
  `      (stream) =>\n` +
  `        Stream.runForEach(stream, (message) =>\n` +
  `          inbox.getByName("global").record(message.body.id),\n` +
  `        ),\n` +
  `    );\n`;

export const echoQueueRoutes =
  `        if (url.pathname === "/queue/send") {\n` +
  `          const id = url.searchParams.get("id") ?? "none";\n` +
  `          yield* echoQueueSend.send({ id }).pipe(Effect.orDie);\n` +
  `          return yield* HttpServerResponse.json({ sent: id });\n` +
  `        }\n` +
  `        if (url.pathname === "/queue/received") {\n` +
  `          const ids = yield* inbox.getByName("global").list();\n` +
  `          return yield* HttpServerResponse.json({ ids });\n` +
  `        }\n`;

export const echoQueueLayers =
  `      Cloudflare.Queues.WriteQueueBinding,\n` +
  `      Cloudflare.Queues.EventSourceLive,\n`;

export const echoInboxClass =
  `/** Durable Object added to a LIVE worker — this carries a class migration. */\n` +
  `export class Inbox extends Cloudflare.DurableObject<Inbox>()(\n` +
  `  "Inbox",\n` +
  `  Effect.succeed(\n` +
  `    Effect.gen(function* () {\n` +
  `      const state = yield* Cloudflare.DurableObjectState;\n` +
  `      return {\n` +
  `        record: Effect.fn(function* (id: string) {\n` +
  `          const ids = (yield* state.storage.get<string[]>("ids")) ?? [];\n` +
  `          yield* state.storage.put("ids", [...ids, id]);\n` +
  `        }),\n` +
  `        list: Effect.fn(function* () {\n` +
  `          return (yield* state.storage.get<string[]>("ids")) ?? [];\n` +
  `        }),\n` +
  `      };\n` +
  `    }),\n` +
  `  ),\n` +
  `) {}\n`;

/** `Stream` is only imported once the queue consumer needs it. */
export const echoStreamImport = `import * as Stream from "effect/Stream";\n`;

// ─── A second S3 bucket + its bindings on the already-running Lambda ────

export const lambdaArchiveBindings =
  `    const archive = yield* S3.Bucket("ArchiveBucket", { forceDestroy: true });\n` +
  `    const putArchive = yield* S3.PutObject(archive);\n` +
  `    const getArchive = yield* S3.GetObject(archive);\n`;

export const lambdaArchiveRoutes =
  `        if (url.pathname === "/archive") {\n` +
  `          yield* putArchive({ Key: "archive.txt", Body: "archived" });\n` +
  `          const object = yield* getArchive({ Key: "archive.txt" });\n` +
  `          const text = yield* (\n` +
  `            object.Body?.pipe(Stream.decodeText, Stream.mkString) ??\n` +
  `              Effect.succeed("")\n` +
  `          );\n` +
  `          return yield* HttpServerResponse.json({ text });\n` +
  `        }\n`;

// ─── A second MicroVM image, and the binding set to drive it ───────────

export const secondImageSource = (marker: string) =>
  `import * as AWS from "alchemy/AWS";\n` +
  `import * as Effect from "effect/Effect";\n` +
  `import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";\n` +
  `import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";\n` +
  `\n` +
  `export const WorkerImageBuildRole = AWS.IAM.Role("StressWorkerVmBuildRole");\n` +
  `\n` +
  `/** A SECOND MicroVM image, added to the stack while dev is running. */\n` +
  `export class WorkerMicrovm extends AWS.Lambda.MicrovmImage<\n` +
  `  WorkerMicrovm,\n` +
  `  { ping: () => Effect.Effect<string> }\n` +
  `>()("StressWorkerVm") {}\n` +
  `\n` +
  `export default WorkerMicrovm.make(\n` +
  `  WorkerImageBuildRole.pipe(\n` +
  `    Effect.map((buildRole) => ({\n` +
  `      main: import.meta.filename,\n` +
  `      buildRole,\n` +
  `      runtime: "bun" as const,\n` +
  `      resources: [{ minimumMemoryInMiB: 512 }],\n` +
  `      cpuConfigurations: [{ architecture: "ARM_64" as const }],\n` +
  `    })),\n` +
  `  ),\n` +
  `  Effect.gen(function* () {\n` +
  `    return {\n` +
  `      fetch: Effect.gen(function* () {\n` +
  `        yield* HttpServerRequest;\n` +
  `        return HttpServerResponse.text(${JSON.stringify(marker)});\n` +
  `      }),\n` +
  `      ping: () => Effect.succeed(${JSON.stringify(marker)}),\n` +
  `    };\n` +
  `  }),\n` +
  `);\n`;

export const secondImageImport =
  `import WorkerImageLive from "./src/extra/WorkerImage.ts";\n`;

/** Spliced into the stack's `Layer.mergeAll`, so it ends with a comma. */
export const secondImageLayer = `        WorkerImageLive,\n`;

/** Bindings + a route on `MicrovmWorker` that drive the SECOND image. */
export const secondImageWorkerImport =
  `import { WorkerMicrovm } from "./extra/WorkerImage.ts";\n`;

export const secondImageBindings =
  `    const runWorkerVm = yield* AWS.Lambda.RunMicrovm(WorkerMicrovm);\n` +
  `    const terminateWorkerVm = yield* AWS.Lambda.TerminateMicrovm(WorkerMicrovm);\n`;

export const secondImageRoutes =
  `        if (url.pathname === "/second") {\n` +
  `          const vm = yield* runWorkerVm({\n` +
  `            idlePolicy: {\n` +
  `              maxIdleDurationSeconds: 900,\n` +
  `              suspendedDurationSeconds: 300,\n` +
  `              autoResumeEnabled: true,\n` +
  `            },\n` +
  `          });\n` +
  `          yield* terminateWorkerVm({ microvmIdentifier: vm.microvmId }).pipe(\n` +
  `            Effect.ignore,\n` +
  `          );\n` +
  `          return yield* HttpServerResponse.json({ microvmId: vm.microvmId });\n` +
  `        }\n`;
