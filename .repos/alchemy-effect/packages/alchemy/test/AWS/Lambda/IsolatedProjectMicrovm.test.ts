import * as AWS from "@/AWS";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  materializeIsolatedProject,
  removeIsolatedProject,
} from "../../IsolatedProject.ts";
import { project } from "./fixtures/microvm/isolated/sandbox.ts";
import IsolatedStack from "./fixtures/microvm/isolated/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
  state: Alchemy.localState(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// MicroVM image builds run server-side (Firecracker snapshot) and can take
// several minutes, so give deploy/destroy plenty of room.
const HOOK_TIMEOUT = 1_500_000;
const TEST_TIMEOUT = 300_000;

// Same gate as MicrovmImage.test.ts: builds are asynchronous (minutes).
const skip = !process.env.LAMBDA_TEST_MICROVM;

// Live proof that the MicroVM bootstrap boots when the image's `main` lives
// in an isolated project (see test/IsolatedProject.ts) — the bundle `cwd`
// resolves none of alchemy's dependencies, so the bootstrap's `alchemy/*` /
// `effect/*` imports must be bundled by the virtual-entry plugin rather than
// found from the project root. With them left external the in-VM server
// dies at module load and the orchestrator's RPC/fetch calls never get a
// reply (the `/rpc` route answers 500).
describe.skipIf(skip)("isolated-project microvm (main)", () => {
  beforeAll(materializeIsolatedProject(project));
  const stack = beforeAll(deploy(IsolatedStack), { timeout: HOOK_TIMEOUT });
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(IsolatedStack), {
    timeout: HOOK_TIMEOUT,
  });
  afterAll(removeIsolatedProject(project));

  test(
    "in-VM program bundled from an isolated project answers RPC and fetch",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const baseUrl = url.replace(/\/+$/, "");
      const client = yield* HttpClient.HttpClient;

      // One request per attempt: the handler runs ONE MicroVM, waits for
      // RUNNING, calls `hello` over RPC and GETs `/echo`, then terminates it.
      //
      // Non-200s are retried on a small budget because a fresh deploy leaves
      // the function's config update `InProgress` for a few seconds, during
      // which AWS still runs the PREVIOUS configuration — whose environment
      // lacks the image ARN this binding injects as `imageIdentifier`, so
      // `runMicrovm` fails to serialize and the route answers 500. (The
      // provider does not block on that window by design; see the precreate
      // stub comment in AWS/Lambda/Function.ts.) Retrying is safe here: the
      // handler terminates the MicroVM it launched via `Effect.ensuring`, on
      // success or failure, so an attempt cannot leak a running VM.
      const res = yield* client.post(`${baseUrl}/rpc?message=world`).pipe(
        Effect.timeout("150 seconds"),
        Effect.flatMap((r) =>
          r.status === 200
            ? Effect.succeed(r)
            : r.text.pipe(
                Effect.flatMap((text) =>
                  Effect.fail(new Error(`/rpc ${r.status}: ${text}`)),
                ),
              ),
        ),
        Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 6 }),
        Effect.orDie,
      );
      const body = (yield* res.json.pipe(Effect.orDie)) as {
        reply: string;
        echo: string;
      };
      expect(body.reply).toBe("hello, world!");
      expect(body.echo).toBe("world");
    }).pipe(logLevel),
    { timeout: TEST_TIMEOUT },
  );
});
