import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  decodeProviderReplayNdjson,
  materializeReplayTranscriptWorkspace,
} from "./replayTranscript.ts";

const header = JSON.stringify({
  type: "transcript_start",
  provider: "codex",
  protocol: "codex.app-server",
  version: "0.156.1",
  scenario: "simple",
});

describe("decodeProviderReplayNdjson", () => {
  it.effect("reads the header and entries, skipping blank lines", () =>
    Effect.gen(function* () {
      const transcript = yield* decodeProviderReplayNdjson(
        [
          header,
          "",
          JSON.stringify({ type: "expect_outbound", frame: { method: "initialize" } }),
          JSON.stringify({ type: "emit_inbound", frame: { result: {} } }),
        ].join("\n"),
      );

      assert.strictEqual(transcript.provider, "codex");
      assert.strictEqual(transcript.scenario, "simple");
      assert.deepStrictEqual(
        transcript.entries.map((entry) => entry.type),
        ["expect_outbound", "emit_inbound"],
      );
    }),
  );

  it.effect("rejects a second transcript_start record", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(decodeProviderReplayNdjson([header, header].join("\n")));

      assert.strictEqual(error._tag, "ProviderReplayNdjsonLineParseError");
      assert.strictEqual(
        error._tag === "ProviderReplayNdjsonLineParseError" && error.lineNumber,
        2,
      );
    }),
  );

  it.effect("requires a header unless fallback metadata is given", () =>
    Effect.gen(function* () {
      const entry = JSON.stringify({ type: "emit_inbound", frame: {} });

      const error = yield* Effect.flip(decodeProviderReplayNdjson(entry));
      assert.strictEqual(error._tag, "ProviderReplayNdjsonMissingHeaderError");

      const transcript = yield* decodeProviderReplayNdjson(entry, {
        provider: "pi",
        protocol: "pi.rpc-jsonl",
        version: "1",
        scenario: "fallback",
      });
      assert.strictEqual(transcript.entries.length, 1);
    }),
  );
});

describe("materializeReplayTranscriptWorkspace", () => {
  it("replaces workspace placeholders in outbound frames only", () => {
    const transcript = materializeReplayTranscriptWorkspace(
      {
        provider: "codex",
        protocol: "codex.app-server",
        version: "0.156.1",
        scenario: "simple",
        entries: [
          {
            type: "expect_outbound",
            frame: { params: { cwd: "<workspace>", argv: ["<workspace>"] } },
          },
          { type: "emit_inbound", frame: { cwd: "<workspace>" } },
        ],
      },
      "/tmp/fixture",
    );

    assert.deepStrictEqual(transcript.entries[0], {
      type: "expect_outbound",
      frame: { params: { cwd: "/tmp/fixture", argv: ["/tmp/fixture"] } },
    });
    assert.deepStrictEqual(transcript.entries[1], {
      type: "emit_inbound",
      frame: { cwd: "<workspace>" },
    });
  });
});
