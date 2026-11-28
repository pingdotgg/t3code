import { describe, expect, it } from "@effect/vitest";
import {
  OrchestratorMcpGmailListRecentResult,
  SecretRequestAnswerResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/http";
import { vi } from "vite-plus/test";

import { exchangeGmailCode, listRecentGmail } from "./GmailApi.ts";

const client = {
  clientId: "123-hyakki-test.apps.googleusercontent.com",
  clientSecret: "test-web-client-secret",
  redirectUri: "http://127.0.0.1:17773/oauth/gmail/callback",
  revision: "test-revision",
};
const scope = "https://www.googleapis.com/auth/gmail.readonly";
const tokenUrl = "https://oauth2.googleapis.com/token";
const mailbox = "https://gmail.googleapis.com/gmail/v1/users/me";
const grant = {
  clientId: client.clientId,
  account: "reader@example.test",
  refreshToken: "test-refresh",
};
const code = { code: "test-private-code", verifier: "test-private-verifier" };
const token = { access_token: "test-access", token_type: "Bearer", scope };

const run = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch));

// Never delegate an unexpected request to the real global fetch, including after all fixtures are consumed.
function mockFetch(respond: (req: Request) => Response | Promise<Response>) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (url, init) => respond(new Request(url, init)));
}

describe("Gmail web OAuth", () => {
  it.effect(
    "uses a confidential web-client PKCE exchange and binds the grant to Gmail's own profile",
    () =>
      Effect.gen(function* () {
        using fetch = mockFetch(async (req) => {
          expect(req.redirect).toBe("error");
          expect(req.credentials).toBe("omit");
          expect(req.headers.has("traceparent")).toBe(false);
          expect(req.url).not.toContain(client.clientSecret);
          expect(Array.from(req.headers.values()).join(" ")).not.toContain(client.clientSecret);
          if (req.url === tokenUrl) {
            expect(req.method).toBe("POST");
            expect(Object.fromEntries(new URLSearchParams(await req.text()))).toEqual({
              grant_type: "authorization_code",
              code: code.code,
              code_verifier: code.verifier,
              client_id: client.clientId,
              client_secret: client.clientSecret,
              redirect_uri: client.redirectUri,
            });
            return Response.json({ ...token, refresh_token: grant.refreshToken });
          }
          expect(req.url).toBe(`${mailbox}/profile?fields=emailAddress`);
          expect(req.headers.get("authorization")).toBe(`Bearer ${token.access_token}`);
          return Response.json({ emailAddress: grant.account, ignored: "private-data" });
        });
        expect(yield* run(exchangeGmailCode(code, client))).toEqual(grant);
        expect(fetch).toHaveBeenCalledTimes(2);
      }),
  );

  it.effect(
    "rejects missing offline access, missing or broader initial scope and bad mailbox identity",
    () =>
      Effect.gen(function* () {
        for (const response of [
          token,
          { ...token, scope: undefined, refresh_token: "r" },
          { ...token, scope: `${scope} email`, refresh_token: "r" },
        ]) {
          using fetch = mockFetch(() => Response.json(response));
          const failure = yield* run(Effect.flip(exchangeGmailCode(code, client)));
          expect(["scope", "authorization"]).toContain(failure.code);
          expect(fetch).toHaveBeenCalledTimes(1);
        }
        using fetch = mockFetch((req) =>
          Response.json(
            req.url === tokenUrl
              ? { ...token, refresh_token: "r" }
              : { emailAddress: "name@example.test\nBcc: victim@example.test" },
          ),
        );
        expect((yield* run(Effect.flip(exchangeGmailCode(code, client)))).code).toBe("profile");
        expect(fetch).toHaveBeenCalledTimes(2);
      }),
  );
});

describe("Gmail read-only transport", () => {
  it.effect(
    "lists only Spam, checks folder membership on get, and returns newest-first bounded summaries",
    () =>
      Effect.gen(function* () {
        using fetch = mockFetch(async (req) => {
          expect(req.redirect).toBe("error");
          if (req.url === tokenUrl) {
            expect(Object.fromEntries(new URLSearchParams(await req.text()))).toEqual({
              grant_type: "refresh_token",
              client_id: grant.clientId,
              client_secret: client.clientSecret,
              refresh_token: grant.refreshToken,
            });
            return Response.json({ ...token, scope: undefined }); // unchanged scope on refresh
          }
          const url = new URL(req.url);
          expect(url.origin).toBe("https://gmail.googleapis.com");
          expect(req.headers.get("authorization")).toBe(`Bearer ${token.access_token}`);
          if (url.pathname.endsWith("/messages")) {
            expect(Object.fromEntries(url.searchParams)).toEqual({
              fields: "messages/id,nextPageToken",
              labelIds: "SPAM",
              includeSpamTrash: "true",
              maxResults: "4",
            });
            return Response.json({
              messages: ["older", "deleted", "latest", "moved"].map((id) => ({ id })),
            });
          }
          const id = url.pathname.split("/").at(-1);
          if (url.searchParams.get("format") === "full") {
            expect(id).toBe("latest");
            expect(url.searchParams.get("fields")).toBe("labelIds,snippet");
            return Response.json({ labelIds: ["SPAM"], snippet: "x".repeat(600) });
          }
          expect(url.searchParams.get("format")).toBe("metadata");
          expect(url.searchParams.getAll("metadataHeaders")).toEqual(["From", "Subject", "Date"]);
          expect(url.searchParams.get("fields")).not.toMatch(/body|attachments|raw/);
          if (id === "deleted") return new Response("private-error-detail", { status: 404 });
          return Response.json({
            internalDate: id === "older" ? "10" : "1000",
            labelIds: [id === "moved" ? "INBOX" : "SPAM"],
            snippet: id === "latest" ? undefined : "first\nmessage",
            payload: {
              headers: [
                {
                  name: "from",
                  value: id === "latest" ? `A\n${"f".repeat(400)}` : "sender@example.test",
                },
                { name: "SUBJECT", value: id === "latest" ? `S\u202e${"s".repeat(600)}` : id },
                {
                  name: "date",
                  value: id === "latest" ? `D\u2028${"d".repeat(200)}` : "mail header date",
                },
                { name: "Bcc", value: "private-cc" },
              ],
              body: { data: "private-message-body" },
            },
          });
        });
        expect(yield* run(listRecentGmail(grant, { folder: "spam", limit: 4 }, client))).toEqual([
          {
            from: `A ${"f".repeat(318)}`,
            subject: `S ${"s".repeat(510)}`,
            date: `D ${"d".repeat(126)}`,
            snippet: "x".repeat(512),
          },
          {
            from: "sender@example.test",
            subject: "older",
            date: "mail header date",
            snippet: "first message",
          },
        ]);
        expect(fetch).toHaveBeenCalledTimes(7);
      }),
  );

  it.effect(
    "backfills a moved and a deleted message without disclosing duplicates or reading past five",
    () =>
      Effect.gen(function* () {
        const lists: Array<[string | null, string | null]> = [];
        const gets: string[] = [];
        using http = mockFetch((req) => {
          if (req.url === tokenUrl) return Response.json(token);
          const url = new URL(req.url);
          if (url.pathname.endsWith("/messages")) {
            expect(url.searchParams.get("labelIds")).toBe("SPAM");
            expect(url.searchParams.get("includeSpamTrash")).toBe("true");
            const cursor = url.searchParams.get("pageToken");
            lists.push([cursor, url.searchParams.get("maxResults")]);
            const ids =
              cursor === null
                ? ["5", "moved", "3", "deleted", "4"]
                : cursor === "a+/="
                  ? ["3", "2"]
                  : ["1"];
            return Response.json({
              messages: ids.map((id) => ({ id })),
              nextPageToken: cursor === null ? "a+/=" : cursor === "a+/=" ? "b" : "more",
            });
          }
          const id = url.pathname.split("/").at(-1)!;
          gets.push(id);
          if (id === "deleted") return new Response(null, { status: 404 });
          return Response.json({
            labelIds: [id === "moved" ? "INBOX" : "SPAM"],
            internalDate: id === "moved" ? "900" : id,
            snippet: id,
          });
        });
        const rows = yield* run(listRecentGmail(grant, { folder: "spam", limit: 5 }, client));
        expect(rows.map((row) => row.snippet)).toEqual(["5", "4", "3", "2", "1"]);
        expect(lists).toEqual([
          [null, "5"],
          ["a+/=", "2"],
          ["b", "1"],
        ]);
        expect(gets.sort()).toEqual(["1", "2", "3", "4", "5", "deleted", "moved"]);
        expect(http).toHaveBeenCalledTimes(11);
      }),
  );

  it.effect(
    "does not report an empty inbox when Gmail repeats a page or the scan budget is exhausted",
    () =>
      Effect.gen(function* () {
        for (const repeats of [true, false]) {
          let pages = 0;
          using http = mockFetch((req) => {
            if (req.url === tokenUrl) return Response.json(token);
            pages++;
            if (pages > 10) throw new Error("unbounded scan");
            return Response.json({ nextPageToken: repeats ? "same" : String(pages) });
          });
          const failure = yield* run(
            Effect.flip(listRecentGmail(grant, { folder: "inbox", limit: 5 }, client)),
          );
          expect(failure.code).toBe(repeats ? "invalid" : "unavailable");
          expect(pages).toBeGreaterThan(1);
          expect(pages).toBeLessThanOrEqual(10);
          expect(http).toHaveBeenCalledTimes(pages + 1);
        }
      }),
  );

  it("bounds the private message list and rejects mailbox content as a model result", () => {
    const encode = Schema.encodeSync(SecretRequestAnswerResult);
    const summary = {
      from: "f".repeat(320),
      subject: "\u{1D11E}".repeat(256),
      date: "d".repeat(128),
      snippet: "s".repeat(512),
    };
    const messages = Array.from({ length: 20 }, () => summary);
    expect(encode({ messages })).toEqual({ messages });
    for (const [key, value] of Object.entries(summary)) {
      const oversized = { ...summary, [key]: value + "x" };
      expect(() => encode({ messages: [oversized] })).toThrow();
    }
    expect(() => encode({ messages: [...messages, summary] })).toThrow();
    const receipt = Schema.decodeUnknownSync(OrchestratorMcpGmailListRecentResult);
    expect(() => receipt({ status: "read", messages })).toThrow();
    expect(receipt({ status: "displayed", count: 5, messages })).toEqual({
      status: "displayed",
      count: 5,
    });
  });

  it.effect(
    "uses INBOX without including Spam/Trash; an empty mailbox does not fetch details",
    () =>
      Effect.gen(function* () {
        using fetch = mockFetch((req) => {
          if (req.url === tokenUrl) return Response.json(token);
          const url = new URL(req.url);
          expect(url.searchParams.get("labelIds")).toBe("INBOX");
          expect(url.searchParams.has("includeSpamTrash")).toBe(false);
          return Response.json({});
        });
        expect(yield* run(listRecentGmail(grant, { folder: "inbox", limit: 5 }, client))).toEqual(
          [],
        );
        expect(fetch).toHaveBeenCalledTimes(2);
      }),
  );

  it.effect(
    "does not refresh under another client, or read mail with an explicitly changed scope",
    () =>
      Effect.gen(function* () {
        using fetch = mockFetch(() =>
          Response.json({ ...token, scope: `${scope} https://mail.google.com/` }),
        );
        const op = { folder: "inbox", limit: 1 } as const;
        expect(
          (yield* run(Effect.flip(listRecentGmail({ ...grant, clientId: "other" }, op, client))))
            .code,
        ).toBe("authorization");
        expect(
          (yield* run(Effect.flip(listRecentGmail(grant, { ...op, limit: 21 }, client)))).code,
        ).toBe("operation");
        expect(fetch).not.toHaveBeenCalled();
        expect((yield* run(Effect.flip(listRecentGmail(grant, op, client)))).code).toBe("scope");
        expect(fetch).toHaveBeenCalledTimes(1);
      }),
  );

  it.effect("rejects unexpected identifiers before issuing a get", () =>
    Effect.gen(function* () {
      using fetch = mockFetch((req) =>
        Response.json(req.url === tokenUrl ? token : { messages: [{ id: "../profile" }] }),
      );
      expect(
        (yield* run(Effect.flip(listRecentGmail(grant, { folder: "inbox", limit: 1 }, client))))
          .code,
      ).toBe("invalid");
      expect(fetch).toHaveBeenCalledTimes(2);
    }),
  );

  it.effect("never follows redirects or returns raw HTTP, parser or transport details", () =>
    Effect.gen(function* () {
      for (const reply of [
        () =>
          new Response("test-private-code", {
            status: 307,
            headers: { location: "https://other.example.test/test-private-code" },
          }),
        () => new Response("test-private-code", { status: 401 }),
        () =>
          Response.json(
            { error: "invalid_client", error_description: client.clientSecret },
            { status: 400 },
          ),
        () => new Response("test-private-code", { status: 200 }),
        () => {
          throw new Error("test-private-code");
        },
      ]) {
        using fetch = mockFetch(reply);
        const failure = yield* run(Effect.flip(exchangeGmailCode(code, client)));
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(String(fetch.mock.calls[0]?.[0])).toBe(tokenUrl);
        expect(fetch.mock.calls[0]?.[1]?.redirect).toBe("error");
        expect(`${failure.message} ${JSON.stringify(failure)}`).not.toContain("test-private-code");
        expect(`${failure.message} ${JSON.stringify(failure)}`).not.toContain(client.clientSecret);
      }
    }),
  );

  it.effect("cancels oversized streamed JSON even without Content-Length", () =>
    Effect.gen(function* () {
      const cancel = vi.fn();
      using fetch = mockFetch(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(100 * 1024));
              },
              cancel,
            }),
          ),
      );
      expect((yield* run(Effect.flip(exchangeGmailCode(code, client)))).code).toBe("invalid");
      expect(cancel).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledOnce();
    }),
  );

  it.effect("aborts the outstanding Google request when the caller interrupts the operation", () =>
    Effect.gen(function* () {
      const started = Promise.withResolvers<AbortSignal>();
      using fetch = mockFetch((req) => {
        const response = Promise.withResolvers<Response>();
        started.resolve(req.signal);
        req.signal.addEventListener("abort", () => response.reject(new Error("interrupted")), {
          once: true,
        });
        return response.promise;
      });
      const pending = yield* listRecentGmail(grant, { folder: "inbox", limit: 1 }, client).pipe(
        Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
        Effect.forkChild,
      );
      const signal = yield* Effect.promise(() => started.promise);
      yield* Fiber.interrupt(pending);
      expect(signal.aborted).toBe(true);
      expect(fetch).toHaveBeenCalledOnce();
    }),
  );
});
