// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Adapted from Miniflare's email plugin tests
 * (`workers-sdk/packages/miniflare/test/plugins/email/index.spec.ts`).
 *
 * Miniflare asserts the persisted file paths by scraping its structured log
 * output; workerd console logs aren't surfaced to these tests, so the
 * persistence cases instead run against a known disk-backed storage
 * directory and assert the written files directly (the log line still fires,
 * carrying the same absolute path). Persisted layout differs deliberately
 * from Miniflare: `.eml` files live at the root of `{storage}/email` and
 * MessageBuilder text/html/attachments under `text/`, `html/` and
 * `attachment/` (Miniflare uses `email/`, `email-text/`, `email-html/`,
 * `email-attachment/` under a temp dir).
 *
 * Upstream tests intentionally not ported here:
 * - All `reply validation` / `reply:` cases: they exercise the incoming
 *   email handler (`/cdn-cgi/handler/email` + `message.reply(...)`), covered
 *   by `test/globals/Email.test.ts`.
 * - "send_email binding is available from getBindings": Miniflare's Node
 *   magic-proxy API has no equivalent here.
 * - Log-format snapshot cases ("MessageBuilder log output format snapshot",
 *   named/mixed-recipient formatting): the formatted log text is produced by
 *   the same ported `formatMessageBuilder`, but logs aren't observable from
 *   these tests; the validation halves of those cases are ported.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as SendEmail from "../../bindings/send-email/index.ts";
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
// Test worker: drives the send_email binding over HTTP
// -----------------------------------------------------------------------------

const TEST_SCRIPT = `
import { EmailMessage } from "cloudflare:email";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/builder") {
        // MessageBuilder API: the JSON body is passed to send() as-is
        const result = await env.SEND_EMAIL.send(await request.json());
        return Response.json(result);
      }
      if (url.pathname === "/message-props") {
        // EmailMessage shim: constructable, from/to synchronously readable,
        // accepts a string raw body
        const message = new EmailMessage("a@example.com", "b@example.com", "raw");
        return Response.json({ from: message.from, to: message.to });
      }
      // EmailMessage API: envelope from the query string, raw MIME body
      const result = await env.SEND_EMAIL.send(new EmailMessage(
        url.searchParams.get("from"),
        url.searchParams.get("to"),
        request.body,
      ));
      return Response.json(result);
    } catch (e) {
      return new Response(String(e), { status: 500 });
    }
  },
};
`;

// Fixtures — MIME bodies hard-coded as constants (\n line endings; the parser
// accepts both \n and \r\n).
const VALID_EMAIL = [
  "From: someone <someone@example.com>",
  "To: someone else <someone-else@example.com>",
  "Message-ID: <im-a-random-message-id@example.com>",
  "MIME-Version: 1.0",
  "Content-Type: text/plain",
  "",
  "This is a random email body.",
].join("\n");

const EMAIL_WITH_RECEIVED_HEADER = [
  "From: someone <someone@example.com>",
  "To: someone else <someone-else@example.com>",
  "Message-ID: <im-a-random-message-id@example.com>",
  "Received: from mail.example.com",
  "MIME-Version: 1.0",
  "Content-Type: text/plain",
  "",
  "This is a random email body.",
].join("\n");

const sendParams = (from: string, to: string) =>
  new URLSearchParams({ from, to }).toString();

// Both branches return an id in the shape production returns:
// `<{36 alphanumeric chars}@{sender domain}>`, angle brackets included.
const messageIdPattern = (domain: string) =>
  new RegExp(`^<[A-Za-z0-9]{36}@${domain.replace(/\./g, "\\.")}>$`);

const compatibilityDate = "2026-03-10";
const modules = [
  { name: "main.js", type: "ESModule", content: TEST_SCRIPT },
] as const;

// -----------------------------------------------------------------------------
// Validation + result shape (shared runtime, no disk assertions)
// -----------------------------------------------------------------------------

layer(localRuntimeLayer)("SendEmail binding", (it) => {
  it.effect(
    "unbound send_email accepts a valid message and synthesizes a messageId",
    () =>
      Effect.gen(function* () {
        const worker = yield* startTestWorker({
          name: "send-email-unbound",
          compatibilityDate,
          compatibilityFlags: [],
          bindings: [SendEmail.local({ binding: "SEND_EMAIL" })],
          modules: [...modules],
        });
        const res = yield* worker.fetch(
          `/?${sendParams("someone@example.com", "someone-else@example.com")}`,
          { method: "POST", body: VALID_EMAIL },
        );
        expect(res.status).toBe(200);
        const body = (yield* Effect.promise(() => res.json())) as {
          messageId: string;
        };
        expect(body.messageId).toMatch(messageIdPattern("example.com"));
      }),
  );

  it.effect("rejects an unparseable message with invalid message-id", () =>
    Effect.gen(function* () {
      const worker = yield* startTestWorker({
        name: "send-email-invalid",
        compatibilityDate,
        compatibilityFlags: [],
        bindings: [SendEmail.local({ binding: "SEND_EMAIL" })],
        modules: [...modules],
      });
      const res = yield* worker.fetch(
        `/?${sendParams("someone@example.com", "someone-else@example.com")}`,
        { method: "POST", body: "adfsedfhwiofe" },
      );
      expect(res.status).toBe(500);
      const text = yield* Effect.promise(() => res.text());
      expect(text).toContain("invalid message-id");
    }),
  );

  it.effect("single allowed destination: matching destination works", () =>
    Effect.gen(function* () {
      const worker = yield* startTestWorker({
        name: "send-email-single-dest",
        compatibilityDate,
        compatibilityFlags: [],
        bindings: [
          SendEmail.local({
            binding: "SEND_EMAIL",
            destinationAddress: "someone-else@example.com",
          }),
        ],
        modules: [...modules],
      });
      const res = yield* worker.fetch(
        `/?${sendParams("someone@example.com", "someone-else@example.com")}`,
        { method: "POST", body: VALID_EMAIL },
      );
      expect(res.status).toBe(200);
    }),
  );

  it.effect(
    "single allowed destination: mismatched destination is rejected",
    () =>
      Effect.gen(function* () {
        const worker = yield* startTestWorker({
          name: "send-email-single-dest-reject",
          compatibilityDate,
          compatibilityFlags: [],
          bindings: [
            SendEmail.local({
              binding: "SEND_EMAIL",
              destinationAddress: "helly.r@example.com",
            }),
          ],
          modules: [...modules],
        });
        const res = yield* worker.fetch(
          `/?${sendParams("someone@example.com", "someone-else@example.com")}`,
          { method: "POST", body: VALID_EMAIL },
        );
        expect(res.status).toBe(500);
        const text = yield* Effect.promise(() => res.text());
        expect(text).toContain("email to someone-else@example.com not allowed");
      }),
  );

  it.effect(
    "allowed destination list: listed destination works, unlisted is rejected",
    () =>
      Effect.gen(function* () {
        const worker = yield* startTestWorker({
          name: "send-email-multi-dest",
          compatibilityDate,
          compatibilityFlags: [],
          bindings: [
            SendEmail.local({
              binding: "SEND_EMAIL",
              allowedDestinationAddresses: [
                "milchick@example.com",
                "miss-huang@example.com",
              ],
            }),
          ],
          modules: [...modules],
        });

        const allowedEmail = [
          "From: someone <someone@example.com>",
          "To: someone else <milchick@example.com>",
          "Message-ID: <im-a-random-message-id@example.com>",
          "MIME-Version: 1.0",
          "Content-Type: text/plain",
          "",
          "This is a random email body.",
        ].join("\n");
        const allowed = yield* worker.fetch(
          `/?${sendParams("someone@example.com", "milchick@example.com")}`,
          { method: "POST", body: allowedEmail },
        );
        expect(allowed.status).toBe(200);

        const rejected = yield* worker.fetch(
          `/?${sendParams("someone@example.com", "helly.r@example.com")}`,
          { method: "POST", body: VALID_EMAIL },
        );
        expect(rejected.status).toBe(500);
        const text = yield* Effect.promise(() => rejected.text());
        expect(text).toContain("email to helly.r@example.com not allowed");
      }),
  );

  it.effect(
    "allowed sender list: listed sender works, unlisted is rejected",
    () =>
      Effect.gen(function* () {
        const worker = yield* startTestWorker({
          name: "send-email-senders",
          compatibilityDate,
          compatibilityFlags: [],
          bindings: [
            SendEmail.local({
              binding: "SEND_EMAIL",
              allowedSenderAddresses: [
                "milchick@example.com",
                "miss-huang@example.com",
              ],
            }),
          ],
          modules: [...modules],
        });

        const allowedEmail = [
          "To: someone <someone@example.com>",
          "From: someone else <milchick@example.com>",
          "Message-ID: <im-a-random-message-id@example.com>",
          "MIME-Version: 1.0",
          "Content-Type: text/plain",
          "",
          "This is a random email body.",
        ].join("\n");
        const allowed = yield* worker.fetch(
          `/?${sendParams("milchick@example.com", "someone@example.com")}`,
          { method: "POST", body: allowedEmail },
        );
        expect(allowed.status).toBe(200);

        const rejected = yield* worker.fetch(
          `/?${sendParams("notallowed@example.com", "someone@example.com")}`,
          { method: "POST", body: allowedEmail },
        );
        expect(rejected.status).toBe(500);
        const text = yield* Effect.promise(() => rejected.text());
        expect(text).toContain("email from notallowed@example.com not allowed");
      }),
  );

  it.effect(
    "rejects a message whose From: header does not match the envelope sender",
    () =>
      Effect.gen(function* () {
        const worker = yield* startTestWorker({
          name: "send-email-from-mismatch",
          compatibilityDate,
          compatibilityFlags: [],
          bindings: [SendEmail.local({ binding: "SEND_EMAIL" })],
          modules: [...modules],
        });
        const res = yield* worker.fetch(
          `/?${sendParams("other-sender@example.com", "someone-else@example.com")}`,
          { method: "POST", body: VALID_EMAIL },
        );
        expect(res.status).toBe(500);
        const text = yield* Effect.promise(() => res.text());
        expect(text).toContain("From: header does not match mail from");
      }),
  );

  it.effect("rejects a message that sets the Received: header", () =>
    Effect.gen(function* () {
      const worker = yield* startTestWorker({
        name: "send-email-received-header",
        compatibilityDate,
        compatibilityFlags: [],
        bindings: [SendEmail.local({ binding: "SEND_EMAIL" })],
        modules: [...modules],
      });
      const res = yield* worker.fetch(
        `/?${sendParams("someone@example.com", "someone-else@example.com")}`,
        { method: "POST", body: EMAIL_WITH_RECEIVED_HEADER },
      );
      expect(res.status).toBe(500);
      const text = yield* Effect.promise(() => res.text());
      expect(text).toContain("invalid headers set");
    }),
  );

  it.effect("MessageBuilder send returns a synthesized messageId", () =>
    Effect.gen(function* () {
      const worker = yield* startTestWorker({
        name: "send-email-builder",
        compatibilityDate,
        compatibilityFlags: [],
        bindings: [SendEmail.local({ binding: "SEND_EMAIL" })],
        modules: [...modules],
      });
      const res = yield* worker.fetch("/builder", {
        method: "POST",
        body: JSON.stringify({
          from: "sender@sender.domain",
          to: "recipient@example.com",
          subject: "s",
          text: "t",
        }),
      });
      expect(res.status).toBe(200);
      const body = (yield* Effect.promise(() => res.json())) as {
        messageId: string;
      };
      expect(body.messageId).toMatch(messageIdPattern("sender.domain"));
    }),
  );

  it.effect(
    "MessageBuilder respects allowed destination addresses (plain, named, RFC5322)",
    () =>
      Effect.gen(function* () {
        const worker = yield* startTestWorker({
          name: "send-email-builder-dest",
          compatibilityDate,
          compatibilityFlags: [],
          bindings: [
            SendEmail.local({
              binding: "SEND_EMAIL",
              allowedDestinationAddresses: ["allowed@example.com"],
            }),
          ],
          modules: [...modules],
        });

        const send = (to: unknown) =>
          worker.fetch("/builder", {
            method: "POST",
            body: JSON.stringify({
              from: "sender@example.com",
              to,
              subject: "Test",
              text: "Test",
            }),
          });

        // plain string
        expect((yield* send("allowed@example.com")).status).toBe(200);
        const plainRejected = yield* send("notallowed@example.com");
        expect(plainRejected.status).toBe(500);
        expect(yield* Effect.promise(() => plainRejected.text())).toContain(
          "not allowed",
        );

        // named EmailAddress object
        expect(
          (yield* send({ name: "Allowed User", email: "allowed@example.com" }))
            .status,
        ).toBe(200);
        const namedRejected = yield* send({
          name: "Blocked User",
          email: "blocked@example.com",
        });
        expect(namedRejected.status).toBe(500);
        expect(yield* Effect.promise(() => namedRejected.text())).toContain(
          "not allowed",
        );

        // RFC5322 string
        expect(
          (yield* send('"Allowed User" <allowed@example.com>')).status,
        ).toBe(200);
        const rfcRejected = yield* send('"Blocked User" <blocked@example.com>');
        expect(rfcRejected.status).toBe(500);
        expect(yield* Effect.promise(() => rfcRejected.text())).toContain(
          "not allowed",
        );
      }),
  );

  it.effect(
    "MessageBuilder respects allowed sender addresses (plain and named)",
    () =>
      Effect.gen(function* () {
        const worker = yield* startTestWorker({
          name: "send-email-builder-sender",
          compatibilityDate,
          compatibilityFlags: [],
          bindings: [
            SendEmail.local({
              binding: "SEND_EMAIL",
              allowedSenderAddresses: ["allowed@example.com"],
            }),
          ],
          modules: [...modules],
        });

        const send = (from: unknown) =>
          worker.fetch("/builder", {
            method: "POST",
            body: JSON.stringify({
              from,
              to: "recipient@example.com",
              subject: "Test",
              text: "T",
            }),
          });

        expect((yield* send("allowed@example.com")).status).toBe(200);
        expect(
          (yield* send({
            name: "Allowed Sender",
            email: "allowed@example.com",
          })).status,
        ).toBe(200);

        const rejected = yield* send("notallowed@example.com");
        expect(rejected.status).toBe(500);
        expect(yield* Effect.promise(() => rejected.text())).toContain(
          "email from notallowed@example.com not allowed",
        );
        const namedRejected = yield* send({
          name: "Blocked",
          email: "blocked@example.com",
        });
        expect(namedRejected.status).toBe(500);
        expect(yield* Effect.promise(() => namedRejected.text())).toContain(
          "not allowed",
        );
      }),
  );

  it.effect("EmailMessage shim is constructable with synchronous from/to", () =>
    Effect.gen(function* () {
      const worker = yield* startTestWorker({
        name: "send-email-message-props",
        compatibilityDate,
        compatibilityFlags: [],
        bindings: [SendEmail.local({ binding: "SEND_EMAIL" })],
        modules: [...modules],
      });
      const body = yield* worker.fetchJson<{ from: string; to: string }>(
        "/message-props",
      );
      expect(body).toEqual({ from: "a@example.com", to: "b@example.com" });
    }),
  );
});

// -----------------------------------------------------------------------------
// Persistence (disk-backed storage, asserted directly on the file system)
// -----------------------------------------------------------------------------

describe("SendEmail binding persistence", () => {
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
    "persists a sent EmailMessage as a .eml file under {storage}/email",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tmp = yield* makeTempDirectory("send-email-persist-");

        yield* Effect.gen(function* () {
          const worker = yield* startTestWorker({
            name: "send-email-persist",
            compatibilityDate,
            compatibilityFlags: [],
            bindings: [SendEmail.local({ binding: "SEND_EMAIL" })],
            modules: [...modules],
          });
          const res = yield* worker.fetch(
            `/?${sendParams("someone@example.com", "someone-else@example.com")}`,
            { method: "POST", body: VALID_EMAIL },
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
        expect(content).toBe(VALID_EMAIL);
      }).pipe(Effect.provide(NodeServices.layer)),
    { timeout: 30_000 },
  );

  it.effect(
    "persists MessageBuilder text, html and attachments under {storage}/email",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tmp = yield* makeTempDirectory("send-email-builder-persist-");

        yield* Effect.gen(function* () {
          const worker = yield* startTestWorker({
            name: "send-email-builder-persist",
            compatibilityDate,
            compatibilityFlags: [],
            bindings: [SendEmail.local({ binding: "SEND_EMAIL" })],
            modules: [...modules],
          });
          const res = yield* worker.fetch("/builder", {
            method: "POST",
            body: JSON.stringify({
              from: "sender@example.com",
              to: "recipient@example.com",
              subject: "Attachment Test",
              text: "Hello, this is a test email!",
              html: "<h1>Hello World</h1>",
              attachments: [
                {
                  disposition: "attachment",
                  filename: "test.txt",
                  type: "text/plain",
                  content: "base64content",
                },
              ],
            }),
          });
          expect(res.status).toBe(200);
        }).pipe(Effect.provide(runtimeLayerTempDir(tmp)), Effect.scoped);

        const emailDir = path.join(tmp, "email");

        const textFiles = yield* fs.readDirectory(path.join(emailDir, "text"));
        expect(textFiles).toHaveLength(1);
        expect(
          yield* fs.readFileString(path.join(emailDir, "text", textFiles[0])),
        ).toBe("Hello, this is a test email!");
        expect(textFiles[0].endsWith(".txt")).toBe(true);

        const htmlFiles = yield* fs.readDirectory(path.join(emailDir, "html"));
        expect(htmlFiles).toHaveLength(1);
        expect(
          yield* fs.readFileString(path.join(emailDir, "html", htmlFiles[0])),
        ).toBe("<h1>Hello World</h1>");
        expect(htmlFiles[0].endsWith(".html")).toBe(true);

        const attachmentFiles = yield* fs.readDirectory(
          path.join(emailDir, "attachment"),
        );
        expect(attachmentFiles).toHaveLength(1);
        expect(
          yield* fs.readFileString(
            path.join(emailDir, "attachment", attachmentFiles[0]),
          ),
        ).toBe("base64content");
        expect(attachmentFiles[0].endsWith(".txt")).toBe(true);
      }).pipe(Effect.provide(NodeServices.layer)),
    { timeout: 30_000 },
  );
});
