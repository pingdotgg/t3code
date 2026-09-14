import { ProviderReplayNdjsonParseError } from "./ReplayTranscriptNdjson.ts";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  decodeProviderReplayNdjson,
  materializeReplayTranscriptWorkspace,
  readProviderReplayTranscript,
} from "./ReplayTranscriptNdjson.ts";

const encodeParseError = Schema.encodeUnknownEffect(ProviderReplayNdjsonParseError);

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
      const encoded = yield* encodeParseError(error);

      assert.equal(error._tag, "ProviderReplayNdjsonLineParseError");
      assert.equal(encoded._tag, "ProviderReplayNdjsonLineParseError");
      if (encoded._tag !== "ProviderReplayNdjsonLineParseError") {
        throw new Error("Expected line parse error encoding.");
      }
      assert.equal(encoded.lineNumber, 1);
      assert.equal(encoded.line, '{"type":');
      const cause = encoded.cause;
      if (typeof cause !== "object" || cause === null || Array.isArray(cause)) {
        throw new Error("Expected encoded parse cause to be a JSON object.");
      }
      const causeRecord = cause as Record<string, unknown>;
      assert.equal(causeRecord.name, "SchemaError");
      assert.doesNotThrow(() => JSON.stringify(encoded));
    }),
  );

  it.effect("materializes outbound workspace placeholders without weakening replay frames", () =>
    Effect.gen(function* () {
      const transcript = yield* decodeProviderReplayNdjson(`
        {"type":"transcript_start","provider":"codex","protocol":"codex.app-server","version":"0.120.0","scenario":"workspace"}
        {"type":"expect_outbound","frame":{"method":"turn/start","params":{"cwd":"<workspace>","nested":["<workspace>"]}}}
        {"type":"emit_inbound","frame":{"method":"item/completed","params":{"text":"<workspace>"}}}
      `);

      const materialized = materializeReplayTranscriptWorkspace(transcript, "/tmp/workspace");

      assert.deepEqual(materialized.entries[0], {
        type: "expect_outbound",
        frame: {
          method: "turn/start",
          params: { cwd: "/tmp/workspace", nested: ["/tmp/workspace"] },
        },
      });
      assert.deepEqual(materialized.entries[1], {
        type: "emit_inbound",
        frame: { method: "item/completed", params: { text: "<workspace>" } },
      });
    }),
  );
});

const FILE_URL_TRANSCRIPT = `{"type":"transcript_start","provider":"codex","protocol":"codex.app-server","version":"0.120.0","scenario":"file-url-read"}
{"type":"runtime_exit","status":"success"}
`;

it.layer(NodeServices.layer)("readProviderReplayTranscript", (it) => {
  it.effect("loads a transcript behind a file URL containing an encoded space", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3 replay fixture " });
      const filePath = path.join(dir, "transcript.ndjson");
      yield* fs.writeFileString(filePath, FILE_URL_TRANSCRIPT);

      const fileUrl = yield* path.toFileUrl(filePath);
      assert.isTrue(fileUrl.pathname.includes("%20"));

      const transcript = yield* readProviderReplayTranscript(fileUrl);
      assert.equal(transcript.scenario, "file-url-read");
    }),
  );

  it.effect("passes drive-letter and UNC file URLs through the Windows path service", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const requestedPaths: Array<string> = [];
      const recordingFs = FileSystem.FileSystem.of({
        ...fs,
        readFileString: (filePath: string) => {
          requestedPaths.push(filePath);
          return Effect.succeed(FILE_URL_TRANSCRIPT);
        },
      });
      const readAsWindows = (file: URL) =>
        readProviderReplayTranscript(file).pipe(
          Effect.provideService(FileSystem.FileSystem, recordingFs),
          Effect.provide(NodePath.layerWin32),
        );

      const driveLetter = yield* readAsWindows(
        new URL("file:///C:/Users/dev/t3%20worktree/transcript.ndjson"),
      );
      const unc = yield* readAsWindows(new URL("file://fileserver/shared/transcript.ndjson"));

      assert.equal(driveLetter.scenario, "file-url-read");
      assert.equal(unc.scenario, "file-url-read");
      assert.deepEqual(requestedPaths, [
        "C:\\Users\\dev\\t3 worktree\\transcript.ndjson",
        "\\\\fileserver\\shared\\transcript.ndjson",
      ]);
    }),
  );

  it.effect("rejects non-file URLs instead of decoding their pathname", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const recordingFs = FileSystem.FileSystem.of({
        ...fs,
        readFileString: () => Effect.succeed(FILE_URL_TRANSCRIPT),
      });
      const error = yield* readProviderReplayTranscript(
        new URL("https://example.com/transcript.ndjson"),
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, recordingFs),
        Effect.provide(NodePath.layerPosix),
        Effect.flip,
      );

      assert.equal(error._tag, "BadArgument");
    }),
  );
});
