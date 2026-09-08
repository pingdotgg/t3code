import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as pathe from "pathe";
import LocalSendEmailWorker from "./fixtures/local-worker.ts";
import RemoteEmailWorker from "./fixtures/remote-email-worker.ts";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command (see
// MakeOptions.sidecar in Test/Core.ts).
const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
}> {}

const getReady = (url: string, expected: Array<number>) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        expected.includes(res.status)
          ? Effect.succeed(res)
          : Effect.fail(new WorkerNotReady({ status: res.status })),
      ),
      Effect.retry({
        while: (e): e is WorkerNotReady => e instanceof WorkerNotReady,
        schedule: Schedule.max([
          Schedule.min([
            Schedule.exponential("500 millis"),
            Schedule.spaced("2 seconds"),
          ]),
          Schedule.recurs(10),
        ]),
      }),
    );
  }).pipe(Effect.orDie);

class EmlNotFound extends Data.TaggedError("EmlNotFound")<{
  directory: string;
}> {}

/**
 * Find the persisted `.eml` under the local runtime storage directory
 * (`.alchemy/local/email`) whose content carries `marker`. Bounded poll: the
 * write happens before `send()` resolves, but the simulator runs in the
 * sidecar process, so allow a few refresh rounds.
 */
const findEmlWithMarker = (marker: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* Effect.sync(() => process.cwd());
    const emailDir = path.join(cwd, ".alchemy", "local", "email");
    const files = yield* fs
      .readDirectory(emailDir)
      .pipe(Effect.orElseSucceed(() => [] as Array<string>));
    for (const name of files) {
      if (!name.endsWith(".eml")) continue;
      const content = yield* fs
        .readFileString(path.join(emailDir, name))
        .pipe(Effect.orElseSucceed(() => ""));
      if (content.includes(`marker:${marker}`)) {
        return content;
      }
    }
    return yield* new EmlNotFound({ directory: emailDir });
  }).pipe(
    Effect.retry({
      while: (e): e is EmlNotFound => e instanceof EmlNotFound,
      schedule: Schedule.spaced("500 millis"),
      times: 10,
    }),
  );

/**
 * Under `alchemy dev` the worker's `send_email` binding is lowered onto the
 * local simulator: `send()` validates the message and persists it as a
 * `.eml` under `.alchemy/local/email` instead of delivering real mail. This
 * exercises the full local roundtrip (EmailMessage + MessageBuilder APIs)
 * and the address validation surfacing to the caller.
 */
test.provider(
  "send_email binding delivers to the local simulator",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const email = yield* Cloudflare.Email.SendEmail("LocalEmail", {
            allowedDestinationAddresses: ["allowed@example.com"],
          });
          const worker = yield* Cloudflare.Worker("send-email-local-worker", {
            main: pathe.resolve(
              import.meta.dirname,
              "fixtures/local-email-worker.ts",
            ),
            env: { EMAIL: email },
          });
          return { worker };
        }),
      );

      // The worker serves from the local dev proxy — proof no deployment to
      // Cloudflare happened (send_email itself is a Worker-only descriptor;
      // there is no cloud resource to check).
      expect(deployed.worker.url).toMatch(/^http:\/\/localhost:\d+$/);

      // EmailMessage API: the message is validated and persisted as .eml.
      const marker = yield* Effect.sync(() => crypto.randomUUID());
      const rawRes = yield* getReady(
        `${deployed.worker.url}/send-raw?marker=${marker}`,
        [200],
      );
      const rawBody = (yield* rawRes.json) as {
        ok: boolean;
        messageId: string;
      };
      expect(rawBody.ok).toBe(true);
      // The simulator synthesizes a production-shaped Message-ID.
      expect(rawBody.messageId).toMatch(/^<[A-Za-z0-9]{36}@example\.com>$/);

      // The .eml landed in the local storage directory with the full MIME
      // message.
      const eml = yield* findEmlWithMarker(marker);
      expect(eml).toContain("From: sender <sender@example.com>");
      expect(eml).toContain(`Message-ID: <${marker}@example.com>`);

      // MessageBuilder API round-trips too.
      const builderRes = yield* getReady(
        `${deployed.worker.url}/send-builder`,
        [200],
      );
      const builderBody = (yield* builderRes.json) as {
        ok: boolean;
        messageId: string;
      };
      expect(builderBody.ok).toBe(true);
      expect(builderBody.messageId).toMatch(/^<[A-Za-z0-9]{36}@example\.com>$/);

      // A disallowed destination surfaces the simulator's validation error
      // to the caller.
      const blockedRes = yield* getReady(
        `${deployed.worker.url}/send-builder?to=blocked@example.com`,
        [500],
      );
      const blockedBody = (yield* blockedRes.json) as {
        ok: boolean;
        message: string;
      };
      expect(blockedBody.ok).toBe(false);
      expect(blockedBody.message).toContain(
        "email to blocked@example.com not allowed",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

/**
 * `Alchemy.remote()` on the descriptor opts a `send_email` binding OUT of
 * local emulation, per binding: one dev worker binds a default (simulated)
 * descriptor and a `remote()`-piped one side by side. The simulator accepts
 * an unrestricted send from an arbitrary address, while the live Email
 * service enforces sender/destination verification and rejects the same
 * pair — proof the call was served by the real binding, with no mail
 * delivered on either route.
 */
test.provider(
  "Alchemy.remote() binds the live service alongside a simulated one",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* LocalSendEmailWorker;
          return { url: worker.url.as<string>() };
        }),
      );

      // The worker itself is served by the local dev proxy.
      expect(deployed.url).toMatch(/^http:\/\/localhost:\d+$/);

      const params =
        "from=noreply%40alchemy-local-test.invalid&to=nobody%40example.com";

      // The simulator accepts the unrestricted send without delivering.
      const stubRes = yield* getReady(
        `${deployed.url}/send-stub?${params}`,
        [200],
      );
      const stub = (yield* stubRes.json) as { ok: boolean };
      expect(stub.ok).toBe(true);

      // The remote()-opted binding reaches the live Email service, which
      // rejects the unverified sender/destination pair.
      const liveRes = yield* getReady(
        `${deployed.url}/send-live?${params}`,
        [200],
      );
      const live = (yield* liveRes.json) as { ok: boolean; message?: string };
      expect(live.ok).toBe(false);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

const FROM = process.env.CLOUDFLARE_TEST_EMAIL_FROM;
const TO = process.env.CLOUDFLARE_TEST_EMAIL_TO;
const skipRemote = !FROM || !TO;

/**
 * `Alchemy.remote()` opts the binding OUT of local emulation: the
 * locally-served worker proxies `send()` through the remote-bindings preview
 * session to the real Cloudflare Email service. Requires a verified
 * sender/destination pair (CLOUDFLARE_TEST_EMAIL_FROM / _TO), same as the
 * live suite — delivery itself cannot be observed out-of-band, so success of
 * the real `send()` is the assertion.
 */
test.provider.skipIf(skipRemote)(
  "Alchemy.remote() proxies send() to the real Email service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* RemoteEmailWorker;
          return { url: worker.url.as<string>() };
        }),
      );

      // Still served locally — only the binding is remote.
      expect(deployed.url).toMatch(/^http:\/\/localhost:\d+$/);

      const sendUrl = `${deployed.url}/send?from=${encodeURIComponent(FROM!)}&to=${encodeURIComponent(TO!)}`;
      const res = yield* getReady(sendUrl, [200]);
      const body = (yield* res.json) as { ok: boolean; message?: string };
      if (!body.ok) {
        throw new Error(`remote send_email failed: ${body.message}`);
      }
      expect(body.ok).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);
