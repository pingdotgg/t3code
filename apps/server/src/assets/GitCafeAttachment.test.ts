import { describe, expect, it } from "@effect/vitest";
import { AssetResource } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { downloadGitCafeAttachment, sniffRasterImageMimeType } from "./GitCafeAttachment.ts";

const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128]);
const resource = { _tag: "gitcafe-attachment", host: "git.cafe", attachmentId: "attach_123abc" };

describe("GitCafe attachment download", () => {
  for (const [name, chunks, code, expected] of [
    ["binary bytes across chunks", [png.slice(0, 4), png.slice(4)], 0, png],
    ["failed authentication", [png], 1, null],
    ["over limit", [new Uint8Array(10 * 1024 * 1024), png], 0, null],
  ] as const) {
    it.effect(name, () =>
      Effect.gen(function* () {
        expect(yield* downloadGitCafeAttachment("staging.git.cafe", "attach_123abc")).toEqual(
          expected,
        );
      }).pipe(
        Effect.provide(
          Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({
            spawn: (command) => {
              expect(command).toMatchObject({
                command: "cafe",
                args: [
                  "--host",
                  "https://staging.git.cafe/api",
                  "--no-input",
                  "--no-update-check",
                  "api",
                  "/attachments/attach_123abc",
                ],
              });
              return Effect.succeed(
                ChildProcessSpawner.makeHandle({
                  pid: ChildProcessSpawner.ProcessId(1),
                  exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
                  isRunning: Effect.succeed(false),
                  kill: () => Effect.void,
                  unref: Effect.succeed(Effect.void),
                  stdin: Sink.drain,
                  stdout: Stream.fromIterable(chunks),
                  stderr: Stream.make(new TextEncoder().encode("diagnostic")),
                  all: Stream.empty,
                  getInputFd: () => Sink.drain,
                  getOutputFd: () => Stream.empty,
                }),
              );
            },
          }),
        ),
      ),
    );
  }
  it("only accepts fixed GitCafe hosts and attachment ids", () => {
    const valid = Schema.is(AssetResource);
    expect(valid(resource)).toBe(true);
    expect(valid({ ...resource, host: "evil.example" })).toBe(false);
    expect(valid({ ...resource, attachmentId: "attach_123/../../auth" })).toBe(false);
    expect(valid({ ...resource, attachmentId: "attach_123?url=evil" })).toBe(false);
  });
  it("sniffs raster signatures rather than trusting file extensions or CLI error output", () => {
    expect(sniffRasterImageMimeType(png)).toBe("image/png");
    expect(sniffRasterImageMimeType(Uint8Array.from([255, 216, 255, 224]))).toBe("image/jpeg");
    expect(sniffRasterImageMimeType(new TextEncoder().encode("GIF89a123"))).toBe("image/gif");
    expect(sniffRasterImageMimeType(new TextEncoder().encode("RIFF1234WEBP"))).toBe("image/webp");
    for (const data of ["<svg></svg>", "<html>error</html>", '{"error":"auth"}', "GIF"])
      expect(sniffRasterImageMimeType(new TextEncoder().encode(data))).toBeNull();
  });
});
