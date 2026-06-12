import * as Alchemy from "@/index.ts";
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import SendEmailWorker from "./fixtures/worker.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const FROM = process.env.CLOUDFLARE_TEST_EMAIL_FROM;
const TO = process.env.CLOUDFLARE_TEST_EMAIL_TO;
const skip = !FROM || !TO;

const Stack = Alchemy.Stack(
  "SendEmailBindingStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* SendEmailWorker;
    return { url: worker.url.as<string>() };
  }),
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY || skip)(destroy(Stack));

test.skipIf(skip)(
  "sends an email through the Worker send_email binding",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;

    const sendUrl = `${url}/send?from=${encodeURIComponent(FROM!)}&to=${encodeURIComponent(TO!)}`;
    const res = yield* client.get(sendUrl).pipe(
      Effect.flatMap((res) =>
        res.status === 200 ? Effect.succeed(res) : Effect.fail(res),
      ),
      Effect.retry({
        schedule: Schedule.exponential("500 millis"),
        times: 10,
      }),
    );
    const body = (yield* res.json) as { ok: boolean; message?: string };
    if (!body.ok) {
      throw new Error(`send_email failed: ${body.message}`);
    }
    expect(body.ok).toBe(true);
  }).pipe(logLevel),
  { timeout: 180_000 },
);
