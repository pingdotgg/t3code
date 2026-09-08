/**
 * Tests for the inbound email trigger route (`/cdn-cgi/handler/email`),
 * ported from Miniflare's email tests
 * (`workers-sdk/packages/miniflare/test/plugins/email/index.spec.ts` — the
 * `reply validation:` / `reply:` cases) plus the dispatch/validation behavior
 * of `workers/core/email.ts` `handleEmail` itself.
 *
 * Deltas from upstream:
 * - Miniflare gates trigger routes behind `unsafeTriggerHandlers`; this
 *   runtime's entry socket only binds 127.0.0.1 during local development, so
 *   the route is always on (same as the scheduled trigger).
 * - Upstream asserts forward/reject/reply logging via its structured log
 *   hook; workerd console logs aren't observable from these tests, so those
 *   cases assert the HTTP response and the state recorded by the `email()`
 *   handler instead, and the reply-persistence case asserts the `.eml`
 *   written under `{storage}/email` directly (Miniflare persists replies via
 *   its loopback `store-temp-file` endpoint; here they go through the
 *   `email:storage` disk service).
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Docker from "../../Docker.ts";
import * as Globals from "../../globals/Globals.ts";
import * as Internet from "../../globals/Internet.ts";
import * as Storage from "../../globals/Storage.ts";
import * as Paths from "../../internal/Paths.ts";
import * as Runtime from "../../Runtime.ts";
import * as RuntimeServices from "../../RuntimeServices.ts";
import * as Workerd from "../../workerd/Workerd.ts";
import {
  localRuntimeLayer,
  makeTempDirectory,
  startTestWorker,
} from "../helpers/runtime.ts";

// -----------------------------------------------------------------------------
// Test workers
// -----------------------------------------------------------------------------

/**
 * Records every `email()` invocation into a module-global array, read back
 * via `GET /received`. The message subject drives extra behavior so one
 * worker covers the reject/forward/throw cases.
 */
const RECORDING_EMAIL_WORKER = `
const received = (globalThis.__received ??= []);
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/received") return Response.json(received);
    return new Response("fetch-ok");
  },
  async email(message) {
    const subject = message.headers.get("subject") ?? "";
    const record = {
      from: message.from,
      to: message.to,
      rawSize: message.rawSize,
      raw: await new Response(message.raw).text(),
      subject,
      messageIdHeader: message.headers.get("message-id"),
    };
    if (subject === "reject-me") {
      await message.setReject("I don't like this email");
    }
    if (subject === "forward-me") {
      record.forwardResult = await message.forward("forward@example.com");
    }
    received.push(record);
    if (subject === "throw-me") {
      throw new Error("email handler boom");
    }
  },
};
`;

/**
 * Replies to every incoming email, mirroring upstream's `REPLY_EMAIL_WORKER`:
 * the reply body defaults to echoing the incoming raw message (whose `From:`
 * header then mismatches the reply envelope sender) and can be overridden
 * with a fixed MIME string per test.
 */
const replyEmailWorker = (email = "message.raw") => `
import { EmailMessage } from "cloudflare:email";

export default {
  async fetch() {
    return new Response("fetch-ok");
  },
  async email(message) {
    const m = new EmailMessage(
      message.to,
      message.from,
      ${email}
    );
    await message.reply(m);
  }
};
`;

// -----------------------------------------------------------------------------
// Fixtures — MIME bodies hard-coded as constants (\n line endings; the parser
// accepts both \n and \r\n).
// -----------------------------------------------------------------------------

const emailFixture = (headers: Array<string>) =>
  [
    ...headers,
    "MIME-Version: 1.0",
    "Content-Type: text/plain",
    "",
    "This is a random email body.",
  ].join("\n");

const VALID_EMAIL = emailFixture([
  "From: someone <someone@example.com>",
  "To: someone else <someone-else@example.com>",
  "Message-ID: <im-a-random-message-id@example.com>",
]);

// >= 100 `@` occurrences in References (upstream counts them instead of
// parsing the header).
const MANY_REFERENCES = Array.from(
  { length: 120 },
  (_, i) => `<ref-${i}@example.net>`,
).join(" ");

const emailParams = (from: string, to: string) =>
  new URLSearchParams({ from, to }).toString();
const EMAIL_PATH = `/cdn-cgi/handler/email?${emailParams(
  "someone@example.com",
  "someone-else@example.com",
)}`;

const compatibilityDate = "2026-03-10";
const workerModules = (script: string) =>
  [{ name: "main.js", type: "ESModule", content: script }] as const;

interface ReceivedEmail {
  from: string;
  to: string;
  rawSize: number;
  raw: string;
  subject: string;
  messageIdHeader: string | null;
  forwardResult?: { messageId: string };
}

// -----------------------------------------------------------------------------
// Dispatch + request validation (shared runtime)
// -----------------------------------------------------------------------------

layer(localRuntimeLayer)("inbound email trigger route", (it) => {
  it.effect("dispatches a valid email to the email() handler", () =>
    Effect.gen(function* () {
      const worker = yield* startTestWorker({
        name: "email-dispatch",
        compatibilityDate,
        compatibilityFlags: [],
        bindings: [],
        modules: [...workerModules(RECORDING_EMAIL_WORKER)],
      });
      const res = yield* worker.fetch(EMAIL_PATH, {
        method: "POST",
        body: VALID_EMAIL,
      });
      expect(res.status).toBe(200);
      expect(yield* Effect.promise(() => res.text())).toBe(
        "Worker successfully processed email",
      );

      const received =
        yield* worker.fetchJson<Array<ReceivedEmail>>("/received");
      expect(received).toHaveLength(1);
      const message = received[0];
      // Envelope addresses come from the URL parameters, the raw MIME body
      // and parsed headers from the request body.
      expect(message.from).toBe("someone@example.com");
      expect(message.to).toBe("someone-else@example.com");
      expect(message.raw).toBe(VALID_EMAIL);
      expect(message.rawSize).toBe(
        new TextEncoder().encode(VALID_EMAIL).byteLength,
      );
      expect(message.messageIdHeader).toBe(
        "<im-a-random-message-id@example.com>",
      );
    }),
  );

  it.effect("rejects a request without from/to parameters", () =>
    Effect.gen(function* () {
      // The missing-body branch of the same 400 isn't separately testable:
      // workerd surfaces a body-less POST as an empty stream, which falls
      // through to the no-message-id 400 instead.
      const worker = yield* startTestWorker({
        name: "email-missing-params",
        compatibilityDate,
        compatibilityFlags: [],
        bindings: [],
        modules: [...workerModules(RECORDING_EMAIL_WORKER)],
      });
      const expectInvalid = (res: Response) =>
        Effect.gen(function* () {
          expect(res.status).toBe(400);
          expect(yield* Effect.promise(() => res.text())).toBe(
            "Invalid email. Your request must include URL parameters specifying the `from` and `to` addresses, as well as an email in the body",
          );
        });

      // No `to`
      yield* expectInvalid(
        yield* worker.fetch("/cdn-cgi/handler/email?from=someone@example.com", {
          method: "POST",
          body: VALID_EMAIL,
        }),
      );
      // No `from`
      yield* expectInvalid(
        yield* worker.fetch(
          "/cdn-cgi/handler/email?to=someone-else@example.com",
          {
            method: "POST",
            body: VALID_EMAIL,
          },
        ),
      );
    }),
  );

  it.effect("rejects an unparseable email", () =>
    Effect.gen(function* () {
      const worker = yield* startTestWorker({
        name: "email-unparseable",
        compatibilityDate,
        compatibilityFlags: [],
        bindings: [],
        modules: [...workerModules(RECORDING_EMAIL_WORKER)],
      });
      // postal-mime parses almost anything; a bare string yields no
      // Message-ID, which is rejected with the same 400 as upstream.
      const res = yield* worker.fetch(EMAIL_PATH, {
        method: "POST",
        body: "adfsedfhwiofe",
      });
      expect(res.status).toBe(400);
      expect(yield* Effect.promise(() => res.text())).toBe(
        "Email could not be parsed: invalid or no message id provided",
      );
    }),
  );

  it.effect("rejects an email without a Message-ID header", () =>
    Effect.gen(function* () {
      const worker = yield* startTestWorker({
        name: "email-no-message-id",
        compatibilityDate,
        compatibilityFlags: [],
        bindings: [],
        modules: [...workerModules(RECORDING_EMAIL_WORKER)],
      });
      const email = emailFixture([
        "From: someone <someone@example.com>",
        "To: someone else <someone-else@example.com>",
      ]);
      const res = yield* worker.fetch(EMAIL_PATH, {
        method: "POST",
        body: email,
      });
      expect(res.status).toBe(400);
      expect(yield* Effect.promise(() => res.text())).toBe(
        "Email could not be parsed: invalid or no message id provided",
      );
    }),
  );

  it.effect("rejects an email above the local 1MiB limit", () =>
    Effect.gen(function* () {
      const worker = yield* startTestWorker({
        name: "email-too-big",
        compatibilityDate,
        compatibilityFlags: [],
        bindings: [],
        modules: [...workerModules(RECORDING_EMAIL_WORKER)],
      });
      const res = yield* worker.fetch(EMAIL_PATH, {
        method: "POST",
        body: "x".repeat(1024 * 1024 + 1),
      });
      expect(res.status).toBe(400);
      expect(yield* Effect.promise(() => res.text())).toContain(
        "exceeds the lower 1Mib limit for testing locally",
      );
    }),
  );

  it.effect("propagates setReject() reasons as a 400", () =>
    Effect.gen(function* () {
      const worker = yield* startTestWorker({
        name: "email-reject",
        compatibilityDate,
        compatibilityFlags: [],
        bindings: [],
        modules: [...workerModules(RECORDING_EMAIL_WORKER)],
      });
      const email = emailFixture([
        "From: someone <someone@example.com>",
        "To: someone else <someone-else@example.com>",
        "Message-ID: <im-a-random-message-id@example.com>",
        "Subject: reject-me",
      ]);
      const res = yield* worker.fetch(EMAIL_PATH, {
        method: "POST",
        body: email,
      });
      expect(res.status).toBe(400);
      expect(yield* Effect.promise(() => res.text())).toBe(
        "Worker rejected email with the following reason: I don't like this email",
      );
    }),
  );

  it.effect("forward() synthesizes a local messageId", () =>
    Effect.gen(function* () {
      const worker = yield* startTestWorker({
        name: "email-forward",
        compatibilityDate,
        compatibilityFlags: [],
        bindings: [],
        modules: [...workerModules(RECORDING_EMAIL_WORKER)],
      });
      const email = emailFixture([
        "From: someone <someone@example.com>",
        "To: someone else <someone-else@example.com>",
        "Message-ID: <im-a-random-message-id@example.com>",
        "Subject: forward-me",
      ]);
      const res = yield* worker.fetch(EMAIL_PATH, {
        method: "POST",
        body: email,
      });
      expect(res.status).toBe(200);
      const received =
        yield* worker.fetchJson<Array<ReceivedEmail>>("/received");
      expect(received).toHaveLength(1);
      // Locally the id is a dashless UUID at a dummy domain (matching
      // Miniflare — production uses a random id at the sender domain).
      expect(received[0].forwardResult?.messageId).toMatch(
        /^[0-9a-f]{32}@example\.com$/,
      );
    }),
  );

  it.effect("returns 500 when the email handler throws", () =>
    Effect.gen(function* () {
      const worker = yield* startTestWorker({
        name: "email-handler-throws",
        compatibilityDate,
        compatibilityFlags: [],
        bindings: [],
        modules: [...workerModules(RECORDING_EMAIL_WORKER)],
      });
      const email = emailFixture([
        "From: someone <someone@example.com>",
        "To: someone else <someone-else@example.com>",
        "Message-ID: <im-a-random-message-id@example.com>",
        "Subject: throw-me",
      ]);
      const res = yield* worker.fetch(EMAIL_PATH, {
        method: "POST",
        body: email,
      });
      expect(res.status).toBe(500);
      expect(yield* Effect.promise(() => res.text())).toContain(
        "email handler boom",
      );
    }),
  );

  it.effect("404s unknown /cdn-cgi/handler/ paths with a hint", () =>
    Effect.gen(function* () {
      const worker = yield* startTestWorker({
        name: "email-unknown-handler",
        compatibilityDate,
        compatibilityFlags: [],
        bindings: [],
        modules: [...workerModules(RECORDING_EMAIL_WORKER)],
      });
      const res = yield* worker.fetch("/cdn-cgi/handler/bogus", {
        method: "POST",
      });
      expect(res.status).toBe(404);
      expect(yield* Effect.promise(() => res.text())).toBe(
        '"/cdn-cgi/handler/bogus" is not a valid handler. Did you mean to use "/cdn-cgi/handler/scheduled" or "/cdn-cgi/handler/email"?',
      );
    }),
  );
});

// -----------------------------------------------------------------------------
// Reply validation (upstream `reply validation:` cases — whether the
// incoming email may be replied to at all)
// -----------------------------------------------------------------------------

layer(localRuntimeLayer)("inbound email reply validation", (it) => {
  const expectNotReplyable = (name: string, extraHeaders: Array<string>) =>
    it.effect(name, () =>
      Effect.gen(function* () {
        const worker = yield* startTestWorker({
          name: `email-${name.replaceAll(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
          compatibilityDate,
          compatibilityFlags: [],
          bindings: [],
          modules: [...workerModules(replyEmailWorker())],
        });
        const email = emailFixture([
          "From: someone <someone@example.com>",
          "To: someone else <someone-else@example.com>",
          "Message-ID: <im-a-random-message-id@example.com>",
          ...extraHeaders,
        ]);
        const res = yield* worker.fetch(EMAIL_PATH, {
          method: "POST",
          body: email,
        });
        expect(res.status).toBe(500);
        expect(yield* Effect.promise(() => res.text())).toContain(
          "Original email is not replyable",
        );
      }),
    );

  expectNotReplyable("x-auto-response-suppress blocks replies", [
    "X-Auto-Response-Suppress: OOF",
  ]);
  expectNotReplyable("Auto-Submitted blocks replies", ["Auto-Submitted: true"]);
  expectNotReplyable("only In-Reply-To blocks replies", [
    "In-Reply-To: <im-a-random-parent-message-id@example.com>",
  ]);
  expectNotReplyable("only References blocks replies", [
    "References: <im-a-random-parent-message-id@example.com>",
  ]);
  expectNotReplyable("more than 100 References entries block replies", [
    "In-Reply-To: <im-a-random-parent-message-id@example.com>",
    `References: ${MANY_REFERENCES}`,
  ]);
});

// -----------------------------------------------------------------------------
// Reply message validation (upstream `reply:` cases — whether the reply
// itself is well-formed)
// -----------------------------------------------------------------------------

layer(localRuntimeLayer)("inbound email reply message validation", (it) => {
  const replyFixture = (headers: Array<string>) =>
    JSON.stringify(emailFixture(headers));

  const expectReplyError = (
    name: string,
    replyEmail: string,
    expectedError: string,
  ) =>
    it.effect(name, () =>
      Effect.gen(function* () {
        const worker = yield* startTestWorker({
          name: `email-${name.replaceAll(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
          compatibilityDate,
          compatibilityFlags: [],
          bindings: [],
          modules: [...workerModules(replyEmailWorker(replyEmail))],
        });
        const res = yield* worker.fetch(EMAIL_PATH, {
          method: "POST",
          body: VALID_EMAIL,
        });
        expect(res.status).toBe(500);
        expect(yield* Effect.promise(() => res.text())).toContain(
          expectedError,
        );
      }),
    );

  // Echoing the incoming raw message back means the reply's `From:` header
  // (someone@example.com) mismatches the reply envelope sender
  // (someone-else@example.com).
  expectReplyError(
    "mismatched From header",
    "message.raw",
    "From: header does not match mail from",
  );

  // Upstream titles this case "unparseable" and expects "could not parse
  // email", but its `.includes()` assertion is a no-op: postal-mime parses
  // an empty message successfully, so the actual first failure — there as
  // here — is the From-header mismatch.
  expectReplyError(
    "empty reply",
    '""',
    "From: header does not match mail from",
  );

  expectReplyError(
    "reply without a message id",
    replyFixture([
      "From: someone else <someone-else@example.com>",
      "To: someone <someone@example.com>",
    ]),
    "invalid message-id",
  );

  expectReplyError(
    "reply with a Received header",
    replyFixture([
      "From: someone else <someone-else@example.com>",
      "To: someone <someone@example.com>",
      "Message-ID: <im-a-random-message-id@example.com>",
      "Received: something",
    ]),
    "invalid headers set",
  );

  expectReplyError(
    "reply without In-Reply-To",
    replyFixture([
      "From: someone else <someone-else@example.com>",
      "To: someone <someone@example.com>",
      "Message-ID: <im-a-random-message-id@example.com>",
    ]),
    "no In-Reply-To header found in reply message",
  );

  expectReplyError(
    "reply with wrong In-Reply-To",
    replyFixture([
      "From: someone else <someone-else@example.com>",
      "To: someone <someone@example.com>",
      "In-Reply-To: random",
      "Message-ID: <im-a-random-message-id@example.com>",
    ]),
    "In-Reply-To does not match original Message-ID",
  );

  // The incoming message here is VALID_EMAIL with
  // Message-ID <im-a-random-message-id@example.com>; a References header not
  // containing that id is invalid.
  expectReplyError(
    "reply with invalid References",
    replyFixture([
      "From: someone else <someone-else@example.com>",
      "To: someone <someone@example.com>",
      "In-Reply-To: <im-a-random-message-id@example.com>",
      "Message-ID: <im-a-random-reply-id@example.com>",
      "References: <im-a-random-other-message-id@example.com>",
    ]),
    "provided References header is invalid",
  );
});

// -----------------------------------------------------------------------------
// Reply persistence (disk-backed storage, asserted directly on the file
// system — upstream asserts the loopback temp file scraped from its logs)
// -----------------------------------------------------------------------------

describe("inbound email reply persistence", () => {
  const runtimeLayerTempDir = (tmp: string) =>
    Runtime.RuntimeLive.pipe(
      Layer.provideMerge(RuntimeServices.layerLocalBindings()),
      Layer.provide(Globals.GlobalsLive),
      Layer.provideMerge(RuntimeServices.layerLoopback()),
      Layer.provide(Storage.layerDisk(tmp)),
      Layer.provide(Internet.InternetLive),
      Layer.provideMerge(RuntimeServices.layerRegistry()),
      Layer.provide(Paths.PathsLive),
      Layer.provide(Docker.DockerLive),
      Layer.provide(Workerd.WorkerdLive),
      Layer.provideMerge(
        Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer),
      ),
    );

  it.effect(
    "generates the References header and persists the reply under {storage}/email",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tmp = yield* makeTempDirectory("email-reply-persist-");

        const incomingEmail = emailFixture([
          "From: someone <someone@example.com>",
          "To: someone else <someone-else@example.com>",
          "Message-ID: <im-a-random-parent-message-id@example.com>",
        ]);
        const replyEmail = emailFixture([
          "From: someone else <someone-else@example.com>",
          "To: someone <someone@example.com>",
          "In-Reply-To: <im-a-random-parent-message-id@example.com>",
          "Message-ID: <im-a-random-message-id@example.com>",
        ]);

        yield* Effect.gen(function* () {
          const worker = yield* startTestWorker({
            name: "email-reply-persist",
            compatibilityDate,
            compatibilityFlags: [],
            bindings: [],
            modules: [
              ...workerModules(replyEmailWorker(JSON.stringify(replyEmail))),
            ],
          });
          const res = yield* worker.fetch(EMAIL_PATH, {
            method: "POST",
            body: incomingEmail,
          });
          expect(yield* Effect.promise(() => res.text())).toBe(
            "Worker successfully processed email",
          );
          expect(res.status).toBe(200);
        }).pipe(Effect.provide(runtimeLayerTempDir(tmp)), Effect.scoped);

        const emailDir = path.join(tmp, "email");
        const names = yield* fs.readDirectory(emailDir);
        const emlFiles = names.filter((name) => name.endsWith(".eml"));
        expect(emlFiles).toHaveLength(1);
        const content = yield* fs.readFileString(
          path.join(emailDir, emlFiles[0]),
        );
        // The reply had no References header, so one referencing the incoming
        // message is prepended.
        expect(content).toContain(
          "References: <im-a-random-parent-message-id@example.com>",
        );
        expect(content.endsWith(replyEmail)).toBe(true);
      }).pipe(Effect.provide(NodeServices.layer)),
    { timeout: 30_000 },
  );
});
