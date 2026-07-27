import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import { readPythonWorkerBundle } from "@/Cloudflare/Workers/PythonWorkerBundle";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as pathe from "pathe";
import { expectUrlContains } from "../Utils/Http.ts";
import { waitForWorkerToBeDeleted } from "../Utils/Worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const main = pathe.resolve(import.meta.dirname, "fixtures/python/worker.py");
const depsMain = pathe.resolve(
  import.meta.dirname,
  "fixtures/python-deps/worker.py",
);
const fastapiMain = pathe.resolve(
  import.meta.dirname,
  "fixtures/python-fastapi/worker.py",
);

describe.concurrent("Cloudflare.Worker with a Python entrypoint", () => {
  test.provider(
    "uploads python modules and serves from the runtime",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        // The bundle the provider must upload: the entry first (it becomes
        // `main_module`), sibling `.py` sources named by their path
        // relative to the entry's directory. No bundler runs — Python
        // sources are interpreted directly by Pyodide.
        const expected = yield* readPythonWorkerBundle({
          id: "PythonWorker",
          main,
          compatibility: { date: "2026-03-17", flags: ["python_workers"] },
        });
        expect(expected.files.map((file) => file.path)).toEqual([
          "worker.py",
          "util.py",
        ]);

        const worker = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("PythonWorker", {
              main,
              subdomain: { enabled: true },
              env: { PY_SUFFIX: "42" },
            });
          }),
        );

        // The stored bundle hash equals the hash of the source bytes only
        // when no bundling/minification ran.
        expect(worker.hash?.bundle).toEqual(expected.hash);

        // End-to-end: the response interpolates a constant from the
        // sibling `util.py` module and an env binding, so it only renders
        // if the module graph and bindings survived the upload.
        expect(worker.url).toBeDefined();
        yield* expectUrlContains(
          worker.url!,
          "alchemy-python-worker-7c1f suffix=42",
        );

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
      }).pipe(logLevel),
    { timeout: 360_000 },
  );

  // Vendors `humanize` (plus the managed `workers-runtime-sdk`) with uv
  // against the Pyodide wheel index and uploads it under
  // `python_modules/`. Requires uv (>= 0.8.10) on PATH.
  test.provider.skipIf(!!process.env.FAST)(
    "vendors pyproject.toml dependencies with uv",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        const bundle = yield* readPythonWorkerBundle({
          id: "PythonDepsWorker",
          main: depsMain,
          compatibility: { date: "2026-03-17", flags: ["python_workers"] },
        });
        const paths = bundle.files.map((file) => file.path);
        expect(paths[0]).toEqual("worker.py");
        // The vendored wheel contents ride along under python_modules/.
        expect(
          paths.some((p) => p.startsWith("python_modules/humanize/")),
        ).toBe(true);
        // pywrangler parity: the managed SDK package is always vendored.
        expect(paths.some((p) => p.startsWith("python_modules/workers/"))).toBe(
          true,
        );

        const worker = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("PythonDepsWorker", {
              main: depsMain,
              subdomain: { enabled: true },
            });
          }),
        );

        // `humanize.intcomma` only resolves if the vendored package was
        // uploaded and is importable at runtime.
        expect(worker.url).toBeDefined();
        yield* expectUrlContains(worker.url!, "vendored=1,234,567");

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
      }).pipe(logLevel),
    { timeout: 360_000 },
  );

  // The supported-package surface of Python Workers, exercised end-to-end
  // through one FastAPI app:
  // - fastapi + pydantic (Pyodide-built-in packages) served via the
  //   runtime-provided `asgi` module
  // - numpy — a compiled-extension wheel, proving vendored binary wheels
  //   match the deployed Pyodide runtime's emscripten-wasm32 ABI
  // - httpx — async outbound HTTP (the only kind Workers support)
  // - env bindings threaded into ASGI routes via `request.scope["env"]`
  test.provider.skipIf(!!process.env.FAST)(
    "serves a FastAPI app with pydantic, numpy, and httpx",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        const worker = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("PythonFastapiWorker", {
              main: fastapiMain,
              subdomain: { enabled: true },
              env: { DEPLOYMENT: "alchemy-fastapi-e2e" },
            });
          }),
        );
        expect(worker.url).toBeDefined();
        const url = worker.url!.replace(/\/$/, "");

        // ASGI routing (absorbs first-deploy propagation via retries).
        yield* expectUrlContains(`${url}/`, '"framework":"fastapi"');
        // Env bindings reach ASGI routes through request.scope["env"].
        yield* expectUrlContains(`${url}/env`, "alchemy-fastapi-e2e");
        // numpy: compiled wheel imports and computes (sum(0..9) = 45).
        yield* expectUrlContains(`${url}/numpy`, '"sum":45');
        // httpx: async outbound subrequest succeeds.
        yield* expectUrlContains(`${url}/outbound`, '"status":200');

        // pydantic: POST body is validated and parsed into the Item model.
        const client = yield* HttpClient.HttpClient;
        const response = yield* HttpClientRequest.post(`${url}/items`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ name: "widget", quantity: 21 }),
          client.execute,
        );
        expect(response.status).toBe(200);
        const body = (yield* response.json) as { name: string; total: number };
        expect(body).toEqual({ name: "widget", total: 42 });

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
      }).pipe(logLevel),
    { timeout: 360_000 },
  );
});
