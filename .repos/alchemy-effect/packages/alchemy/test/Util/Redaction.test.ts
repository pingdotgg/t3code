import { describe, expect, test } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import {
  collectRedactedSecrets,
  redactionMarker,
  redactJson,
  redactStream,
  redactText,
} from "@/Util/Redaction.ts";

const tags = ["unit", "local"];

describe("collectRedactedSecrets", () => {
  test(
    "collects strings inside redacted values and containers",
    () => {
      expect(collectRedactedSecrets({ token: Redacted.make("s3cr3t") })).toEqual(["s3cr3t"]);
      expect(collectRedactedSecrets(Redacted.make({ token: "s3cr3t" }))).toEqual(["s3cr3t"]);
      expect(
        collectRedactedSecrets(Redacted.make(["s3cr3t", { nested: "another-secret" }])),
      ).toEqual(["s3cr3t", "another-secret"]);
      expect(
        collectRedactedSecrets({ public: "ordinary-text", token: Redacted.make("s3cr3t") }),
      ).toEqual(["s3cr3t"]);
      expect(
        collectRedactedSecrets(
          Redacted.make({
            token: Redacted.make("s3cr3t"),
            nested: { password: "another-secret" },
          }),
        ),
      ).toEqual(["s3cr3t", "another-secret"]);
      expect(collectRedactedSecrets(Redacted.make({ pin: "ab" }))).toEqual(["ab"]);
      expect(collectRedactedSecrets(Redacted.make(123456))).toEqual(["123456"]);
    },
    { tags },
  );

  test(
    "parses a redacted JSON string so its inner values are secrets too",
    () => {
      expect(collectRedactedSecrets(Redacted.make('{"pin":"s3cr3t"}'))).toEqual([
        '{"pin":"s3cr3t"}',
        "s3cr3t",
      ]);
    },
    { tags },
  );

  test(
    "skips empty strings, plain numbers and non-plain objects, and de-duplicates",
    () => {
      expect(collectRedactedSecrets(Redacted.make(""))).toEqual([]);
      expect(collectRedactedSecrets({ port: 8080, token: Redacted.make("s3cr3t") })).toEqual([
        "s3cr3t",
      ]);
      expect(collectRedactedSecrets(Redacted.make(new Date(0)))).toEqual([]);
      expect(collectRedactedSecrets([Redacted.make("s3cr3t"), Redacted.make("s3cr3t")])).toEqual([
        "s3cr3t",
      ]);
    },
    { tags },
  );

  test(
    "parses a redacted JSON array and keeps a string that only looks like JSON",
    () => {
      expect(collectRedactedSecrets(Redacted.make('["a1b2","c3d4"]'))).toEqual([
        '["a1b2","c3d4"]',
        "a1b2",
        "c3d4",
      ]);
      expect(collectRedactedSecrets(Redacted.make("{not json"))).toEqual(["{not json"]);
    },
    { tags },
  );
});

describe("redactText", () => {
  test(
    "replaces the raw, base64 and JSON-escaped forms of a secret",
    () => {
      const secret = 'pa"ss';
      const base64 = Buffer.from(secret).toString("base64");
      expect(redactText(`raw ${secret} b64 ${base64} json pa\\"ss`, [secret])).toBe(
        "raw <redacted> b64 <redacted> json <redacted>",
      );
    },
    { tags },
  );

  test(
    "matches long secrets anywhere and short secrets only as whole tokens",
    () => {
      expect(redactText("prefixs3cr3tsuffix", ["s3cr3t"])).toBe("prefix<redacted>suffix");
      expect(redactText("code 14293 says 42", ["42"])).toBe("code 14293 says <redacted>");
    },
    { tags },
  );

  test(
    "replaces the longest secret first when one is a prefix of another",
    () => {
      expect(redactText("value abcdefghij", ["abcd", "abcdefghij"])).toBe("value <redacted>");
    },
    { tags },
  );

  test(
    "uses the caller's marker",
    () => {
      expect(redactText("token s3cr3t", ["s3cr3t"], "[REDACTED]")).toBe("token [REDACTED]");
    },
    { tags },
  );

  test(
    "matches a short secret literally, not as a regex",
    () => {
      expect(redactText("1x2 and 1.2", ["1.2"])).toBe("1x2 and <redacted>");
    },
    { tags },
  );

  test(
    "matches a form anywhere when any secret producing it is long",
    () => {
      // "NDI=" is both a long secret and the base64 form of the short "42".
      expect(redactText("xNDI=x", ["NDI=", "42"])).toBe("x<redacted>x");
    },
    { tags },
  );

  test(
    "returns the text unchanged without secrets",
    () => {
      expect(redactText("s3cr3t", [])).toBe("s3cr3t");
    },
    { tags },
  );
});

describe("redactJson", () => {
  test(
    "redacts JSON leaf by leaf and falls back to text",
    () => {
      const body = JSON.stringify({
        n: 14293,
        token: "42",
        data: Buffer.from("42").toString("base64"),
        message: 'code 14293 says "42"',
      });
      expect(JSON.parse(redactJson(body, ["42"]))).toEqual({
        n: 14293,
        token: "<redacted>",
        data: "<redacted>",
        message: 'code 14293 says "<redacted>"',
      });
      expect(JSON.parse(redactJson('{"message":"abcdefghij"}', ["abcd", "abcdefghij"]))).toEqual({
        message: "<redacted>",
      });
      expect(redactJson("rendered a v1/s3cr3t name", ["s3cr3t"])).toBe(
        "rendered a v1/<redacted> name",
      );
    },
    { tags },
  );

  test(
    "redacts a number leaf equal to a secret and keeps other leaves",
    () => {
      expect(JSON.parse(redactJson('{"n":42,"list":["42",null,true,7]}', ["42"]))).toEqual({
        n: "<redacted>",
        list: ["<redacted>", null, true, 7],
      });
    },
    { tags },
  );

  test(
    "returns the text unchanged without secrets",
    () => {
      expect(redactJson('{ "a": 1 }', [])).toBe('{ "a": 1 }');
    },
    { tags },
  );
});

describe("redactStream", () => {
  test.effect(
    "redacts a secret split across chunks, including its base64 form",
    () =>
      Effect.gen(function* () {
        const base64 = Buffer.from("s3cr3t").toString("base64");
        const chunks = ["one s3c", "r3t two ", base64.slice(0, 3), base64.slice(3), " end"];
        const out = yield* Stream.fromIterable(chunks).pipe(
          (stream) => redactStream(stream, ["s3cr3t"]),
          Stream.mkString,
        );
        expect(out).toBe("one <redacted> two <redacted> end");
      }),
    { tags },
  );

  test.effect(
    "output does not depend on chunking when one secret overlaps another",
    () =>
      Effect.gen(function* () {
        const cases = [
          // A shorter secret is a prefix of a longer one (#2399).
          {
            secrets: ["hunter2", "hunter2-admin-token"],
            text: "token=hunter2-admin-token\n",
            expected: "token=<redacted>\n",
          },
          { secrets: ["aa\\\\", 'aa\\\\"'], text: 'aa\\\\"', expected: "<redacted>" },
          // A shorter secret sits inside a longer one that starts earlier.
          {
            secrets: ["mid-secret", "outer-mid-secret-tail"],
            text: "x outer-mid-secret-tail y",
            expected: "x <redacted> y",
          },
        ];
        for (const { secrets, text, expected } of cases) {
          const whole = yield* Stream.make(text).pipe(
            (stream) => redactStream(stream, secrets),
            Stream.mkString,
          );
          expect(whole).toBe(expected);
          for (let split = 1; split < text.length; split++) {
            const out = yield* Stream.make(text.slice(0, split), text.slice(split)).pipe(
              (stream) => redactStream(stream, secrets),
              Stream.mkString,
            );
            expect(out).toBe(expected);
          }
        }
      }),
    { tags },
  );

  const streamed = (
    chunks: ReadonlyArray<string>,
    secrets: ReadonlyArray<string>,
    marker?: string,
  ) =>
    Stream.fromIterable(chunks).pipe(
      (stream) => redactStream(stream, secrets, marker),
      Stream.mkString,
    );

  test.effect(
    "flushes a held-back match when the stream ends",
    () =>
      Effect.gen(function* () {
        const secrets = ["hunter2", "hunter2-admin-token"];
        expect(yield* streamed(["token=hunter2"], secrets)).toBe("token=<redacted>");
        expect(yield* streamed(["hunter2-adm", "in"], secrets)).toBe("<redacted>-admin");
        expect(yield* streamed(["key=s3c"], ["s3cr3t"])).toBe("key=s3c");
      }),
    { tags },
  );

  test.effect(
    "redacts several matches in one chunk and a JSON-escaped form split across chunks",
    () =>
      Effect.gen(function* () {
        expect(yield* streamed(["s3cr3t and s3cr3t"], ["s3cr3t"])).toBe(
          "<redacted> and <redacted>",
        );
        expect(yield* streamed(["msg pa\\", '"ss end'], ['pa"ss'])).toBe("msg <redacted> end");
      }),
    { tags },
  );

  test.effect(
    "matches short secrets anywhere, unlike redactText",
    () =>
      Effect.gen(function* () {
        expect(yield* streamed(["code 14293"], ["42"])).toBe("code 1<redacted>93");
      }),
    { tags },
  );

  test.effect(
    "uses the caller's marker and passes chunks through without secrets",
    () =>
      Effect.gen(function* () {
        expect(yield* streamed(["token s3cr3t"], ["s3cr3t"], "[REDACTED]")).toBe(
          "token [REDACTED]",
        );
        const chunks = yield* Stream.fromIterable(["a", "b"]).pipe(
          (stream) => redactStream(stream, []),
          Stream.runCollect,
        );
        expect([...chunks]).toEqual(["a", "b"]);
      }),
    { tags },
  );
});

describe("redactionMarker", () => {
  test(
    "keeps the preferred marker unless a secret appears inside it",
    () => {
      expect(redactionMarker(["s3cr3t"], "[REDACTED]")).toBe("[REDACTED]");
      const marker = redactionMarker(["[REDACTED]"], "[REDACTED]");
      expect(marker).not.toBe("[REDACTED]");
      expect("[REDACTED]".includes(marker)).toBe(false);
    },
    { tags },
  );

  test(
    "falls back to a supplementary private-use character, then to an empty marker",
    () => {
      const range = (from: number, to: number) => {
        let out = "";
        for (let codePoint = from; codePoint <= to; codePoint++) {
          out += String.fromCodePoint(codePoint);
        }
        return out;
      };
      const basic = range(0xe000, 0xf8ff);
      expect(redactionMarker(["redacted", basic])).toBe(String.fromCodePoint(0xf0000));
      expect(redactionMarker(["redacted", basic, range(0xf0000, 0xffffd)])).toBe("");
    },
    { tags },
  );
});
