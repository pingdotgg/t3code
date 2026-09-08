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
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as pathe from "pathe";

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

const getReady = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : Effect.fail(new WorkerNotReady({ status: res.status })),
      ),
      Effect.retry({
        while: (e): e is WorkerNotReady => e instanceof WorkerNotReady,
        // Cap the backoff: an uncapped exponential over 10 recurs sums to
        // ~8.5 minutes and turns a persistent non-200 into an apparent hang.
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

// -----------------------------------------------------------------------------
// MIME fixtures — hard-coded constants mirroring the runtime's own inbound
// email tests (\n line endings; the parser accepts both \n and \r\n).
// -----------------------------------------------------------------------------

const FROM = "someone@example.com";
const TO = "someone-else@example.com";

const emailFixture = (headers: Array<string>) =>
  [
    ...headers,
    "MIME-Version: 1.0",
    "Content-Type: text/plain",
    "",
    "This is a random email body.",
  ].join("\n");

const incomingEmail = (subject: string, messageId: string) =>
  emailFixture([
    `From: someone <${FROM}>`,
    `To: someone else <${TO}>`,
    `Subject: ${subject}`,
    `Message-ID: ${messageId}`,
  ]);

const emailTriggerPath = (workerUrl: string) =>
  `${workerUrl}/cdn-cgi/handler/email?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`;

/** POST a raw MIME message to the worker's inbound email trigger route. */
const postEmail = (workerUrl: string, raw: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.execute(
      HttpClientRequest.post(emailTriggerPath(workerUrl)).pipe(
        HttpClientRequest.bodyText(raw),
      ),
    );
  });

interface ReceivedEmail {
  from: string;
  to: string;
  rawSize: number;
  raw: string;
  subject: string;
  messageIdHeader: string | null;
}

class EmlNotFound extends Data.TaggedError("EmlNotFound")<{
  directory: string;
}> {}

/**
 * Find the persisted reply `.eml` under the local runtime storage directory
 * (`.alchemy/local/email`) whose content carries `marker`. Bounded poll: the
 * write happens before `reply()` resolves, but the simulator runs in the
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
      if (content.includes(`reply-marker:${marker}`)) {
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
 * Under `alchemy dev` the local runtime dispatches
 * `POST {workerUrl}/cdn-cgi/handler/email?from=X&to=Y` (raw MIME body) to
 * the worker's `email()` handler — mirroring Miniflare's inbound email
 * trigger route. This exercises the full local roundtrip: dispatch (200),
 * `setReject` (400 with the reason), and `message.reply(...)` persisting the
 * reply `.eml` under the local storage's `email/` dir.
 */
test.provider(
  "inbound email trigger dispatches to the worker's email() handler",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const kv = yield* Cloudflare.KV.Namespace("EmailHandlerKV");
          const worker = yield* Cloudflare.Worker("email-handler-worker", {
            main: pathe.resolve(
              import.meta.dirname,
              "fixtures/email-handler-worker.ts",
            ),
            env: { KV: kv },
          });
          return { worker };
        }),
      );

      // The worker serves from the local dev proxy — proof no deployment to
      // Cloudflare happened.
      expect(deployed.worker.url).toMatch(/^http:\/\/localhost:\d+$/);

      // Wait for the local worker to serve before driving the trigger route.
      yield* getReady(deployed.worker.url!);

      const marker = yield* Effect.sync(() => crypto.randomUUID());

      // 1. Accepted email → 200, and the handler observed the envelope
      //    addresses, the raw MIME content, and the parsed headers.
      const okRaw = incomingEmail(
        `accept-me:${marker}`,
        `<incoming-${marker}@example.com>`,
      );
      const okRes = yield* postEmail(deployed.worker.url!, okRaw);
      expect(okRes.status).toBe(200);
      expect(yield* okRes.text).toBe("Worker successfully processed email");

      const received = (yield* (yield* getReady(
        `${deployed.worker.url}/received`,
      )).json) as unknown as Array<ReceivedEmail>;
      expect(received).toHaveLength(1);
      const message = received[0];
      // Envelope addresses come from the URL parameters, the raw MIME body
      // and parsed headers from the request body.
      expect(message.from).toBe(FROM);
      expect(message.to).toBe(TO);
      expect(message.subject).toBe(`accept-me:${marker}`);
      expect(message.raw).toBe(okRaw);
      expect(message.rawSize).toBe(new TextEncoder().encode(okRaw).byteLength);
      expect(message.messageIdHeader).toBe(`<incoming-${marker}@example.com>`);

      // 2. `setReject(reason)` → 400 carrying the reject reason.
      const rejectRes = yield* postEmail(
        deployed.worker.url!,
        incomingEmail("reject-me", `<reject-${marker}@example.com>`),
      );
      expect(rejectRes.status).toBe(400);
      expect(yield* rejectRes.text).toBe(
        "Worker rejected email with the following reason: I don't like this email",
      );

      // 3. `message.reply(new EmailMessage(...))` → 200, and the reply `.eml`
      //    is persisted under the local storage's `email/` dir with the
      //    generated `References` header pointing at the incoming message.
      const replyRes = yield* postEmail(
        deployed.worker.url!,
        incomingEmail(`reply-me:${marker}`, `<parent-${marker}@example.com>`),
      );
      expect(replyRes.status).toBe(200);
      expect(yield* replyRes.text).toBe("Worker successfully processed email");

      const eml = yield* findEmlWithMarker(marker);
      // The reply had no References header, so the runtime prepends one
      // referencing the incoming message before persisting.
      expect(eml).toContain(`References: <parent-${marker}@example.com>`);
      expect(eml).toContain(`In-Reply-To: <parent-${marker}@example.com>`);
      expect(eml).toContain(`Message-ID: <reply-${marker}@example.com>`);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);
