import { describe, it, expect } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Native from "./OpenCode2Client.ts";
import * as Startup from "./OpenCodeStartup.ts";
import * as Forms from "./OpenCode2Forms.ts";
import type { FormInfo } from "@opencode/client";

describe("OpenCode 2 protocol", () => {
  it("waits for a complete generated password and preserves V1 startup", () => {
    const url = "http://127.0.0.1:4096";
    expect(Startup.parse(`server listening on ${url}\n`)).toBeNull();
    expect(Startup.parse(`server listening on ${url}\nserver password sec`)).toBeNull();
    expect(Startup.parse(`server listening on ${url}\nserver password secret\n`)).toEqual({
      url,
      serverPassword: "secret",
      apiVersion: 2,
    });
    expect(Startup.parse(`opencode server listening on ${url}\n`)).toEqual({
      url,
      serverPassword: undefined,
      apiVersion: 1,
    });
    expect(Startup.parse(`server listening on ${url}\n`, "configured")).toEqual({
      url,
      serverPassword: "configured",
      apiVersion: 2,
    });
    expect(Startup.redact("error\nserver password secret\nnext")).toBe(
      "error\nserver password [REDACTED]\nnext",
    );
  });

  effectIt.effect("follows even a nonempty final-page cursor without sending order again", () =>
    Effect.gen(function* () {
      const queries: string[] = [];
      const client = Native.make({
        url: "http://opencode.test",
        serverPassword: "secret",
        fetch: async (input, init) => {
          const url = new URL(String(input));
          queries.push(url.search);
          expect(new Headers(init?.headers).get("authorization")).toBe(
            `Basic ${Buffer.from("opencode:secret").toString("base64")}`,
          );
          if (url.searchParams.has("cursor")) {
            expect(url.searchParams.has("order")).toBe(false);
            return Response.json({ data: [], cursor: {} });
          }
          return Response.json({
            data: [{ id: "msg_one", type: "user", text: "hello", time: { created: 1 } }],
            cursor: { next: "last-page" },
          });
        },
      });
      const history = yield* Native.messages(client, "ses_test");
      expect(history.map((message) => message.id)).toEqual(["msg_one"]);
      expect(queries).toHaveLength(2);
    }),
  );

  effectIt.effect("rejects a cursor cycle instead of returning truncated history", () =>
    Effect.gen(function* () {
      const client = Native.make({
        url: "http://opencode.test",
        fetch: async () =>
          Response.json({
            data: [{ id: "msg_one", type: "user", text: "hello", time: { created: 1 } }],
            cursor: { next: "repeated" },
          }),
      });
      const result = yield* Native.messages(client, "ses_test").pipe(Effect.exit);
      expect(result._tag).toBe("Failure");
    }),
  );

  it("writes real native session permissions through the generated client", async () => {
    const client = Native.make({
      url: "http://opencode.test",
      fetch: async (input, init) => {
        expect(new URL(String(input)).pathname).toBe("/api/session/ses_test");
        expect(init?.method).toBe("PATCH");
        const body = JSON.parse(String(init?.body));
        expect(body.permissions).toContainEqual({ action: "edit", resource: "*", effect: "ask" });
        expect(body.permission).toBeUndefined();
        return new Response(null, { status: 204 });
      },
    });
    await client.session.update({
      sessionID: "ses_test",
      permissions: Native.sessionRules("approval-required"),
    });
  });
});

describe("OpenCode forms", () => {
  const form: FormInfo = {
    id: "frm_test",
    sessionID: "ses_test",
    title: "Inputs",
    fields: [
      { key: "text", type: "string", required: true },
      { key: "count", type: "integer", required: true },
      { key: "enabled", type: "boolean", required: true },
    ],
  };
  effectIt.effect("preserves whitespace and the declared value types", () =>
    Effect.gen(function* () {
      expect(yield* Forms.answer(form, { text: "  true  ", count: "2", enabled: "false" })).toEqual(
        { text: "  true  ", count: 2, enabled: false },
      );
    }),
  );
  effectIt.effect("does not accept fractional integers or silently omit required fields", () =>
    Effect.gen(function* () {
      expect(
        (yield* Forms.answer(form, { text: "test", count: "1.5", enabled: "true" }).pipe(
          Effect.exit,
        ))._tag,
      ).toBe("Failure");
      expect((yield* Forms.answer(form, { text: "test", count: "1" }).pipe(Effect.exit))._tag).toBe(
        "Failure",
      );
    }),
  );
  it("declines conditional forms rather than flattening away their rules", () => {
    expect(
      Forms.supported({ ...form, fields: [{ key: "text", type: "string", hidden: true }] }),
    ).toBe(false);
    expect(Forms.supported(form)).toBe(true);
  });
});
