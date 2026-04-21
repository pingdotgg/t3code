import { ProviderReplayNdjsonParseError } from "./ReplayTranscriptNdjson.ts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { decodeProviderReplayNdjson } from "./ReplayTranscriptNdjson.ts";

describe("decodeProviderReplayNdjson", () => {
  it.effect("decodes a self-describing provider replay fixture", () =>
    Effect.gen(function* () {
      const transcript = yield* decodeProviderReplayNdjson(`
        {"type":"transcript_start","provider":"codex","protocol":"codex.app-server","version":"0.120.0","scenario":"simple"}
        {"type":"expect_outbound","label":"initialize","frame":{"id":1,"method":"initialize","params":{}}}
        {"type":"emit_inbound","label":"initialized","afterMs":5,"frame":{"id":1,"result":{"ok":true}}}
        {"type":"runtime_exit","status":"success"}
      `);

      assert.equal(transcript.provider, "codex");
      assert.equal(transcript.protocol, "codex.app-server");
      assert.equal(transcript.scenario, "simple");
      assert.deepEqual(
        transcript.entries.map((entry) => entry.type),
        ["expect_outbound", "emit_inbound", "runtime_exit"],
      );
    }),
  );

  it.effect("decodes entry-only fixtures when metadata is supplied by the test", () =>
    Effect.gen(function* () {
      const transcript = yield* decodeProviderReplayNdjson(
        `
          {"type":"emit_inbound","frame":{"method":"thread/created","params":{"id":"native-thread"}}}
          {"type":"runtime_exit","status":"success"}
        `,
        {
          provider: "claudeAgent",
          protocol: "claude-agent-sdk",
          version: "0.2.111",
          scenario: "entry-only",
        },
      );

      assert.equal(transcript.provider, "claudeAgent");
      assert.equal(transcript.entries.length, 2);
    }),
  );

  it.effect("returns a schema-serializable typed parse error", () =>
    Effect.gen(function* () {
      const error = yield* decodeProviderReplayNdjson(`{"type":`).pipe(Effect.flip);
      const encoded = Schema.encodeUnknownSync(ProviderReplayNdjsonParseError)(error);

      assert.equal(error._tag, "ProviderReplayNdjsonLineParseError");
      assert.equal(encoded._tag, "ProviderReplayNdjsonLineParseError");
      if (encoded._tag !== "ProviderReplayNdjsonLineParseError") {
        throw new Error("Expected line parse error encoding.");
      }
      assert.equal(encoded.lineNumber, 1);
      assert.equal(encoded.line, '{"type":');
      assert.deepEqual(encoded.cause, {
        name: "Error",
        message: "SyntaxError: Unexpected end of JSON input",
      });
      assert.deepEqual(encoded, {
        _tag: "ProviderReplayNdjsonLineParseError",
        lineNumber: 1,
        line: '{"type":',
        cause: {
          name: "Error",
          message: "SyntaxError: Unexpected end of JSON input",
        },
      });
    }),
  );
});
