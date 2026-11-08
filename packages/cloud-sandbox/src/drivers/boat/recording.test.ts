// @effect-diagnostics-next-line nodeBuiltinImport:off -- Execute the emitted Python against an isolated process-table fixture.
import * as NodeChildProcess from "node:child_process";
import { expect, it } from "@effect/vitest";
import { createBoatApiClient } from "@t3tools/boat";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { createBoatRecording } from "./recording.ts";

it.effect("refuses invalid recorder IDs, foreign artifacts, and unfinished downloads", () =>
  Effect.gen(function* () {
    let commands = 0;
    let downloads = 0;
    let path = "/home/user/.t3/recordings/owned.mp4";
    let state = "recording";
    const httpClient = HttpClient.make((request) => {
      if (request.url.includes("/artifacts")) {
        downloads++;
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(new Uint8Array([1, 2]))),
        );
      }
      commands++;
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            ok: true,
            success: true,
            exitCode: 0,
            stderr: "",
            timedOut: false,
            stdout: JSON.stringify({ recordingId: "owned", state, path, mimeType: "video/mp4" }),
          }),
        ),
      );
    });
    const recording = createBoatRecording(createBoatApiClient({ apiKey: "boat_test", httpClient }));
    expect(
      (yield* recording.start("bx_23456789", "bad; touch /tmp/unsafe").pipe(Effect.result))._tag,
    ).toBe("Failure");
    expect(commands).toBe(0);
    expect((yield* recording.getArtifact("bx_23456789", "owned").pipe(Effect.result))._tag).toBe(
      "Failure",
    );
    expect(downloads).toBe(0);
    state = "completed";
    path = "/home/user/external.mp4";
    expect((yield* recording.getArtifact("bx_23456789", "owned").pipe(Effect.result))._tag).toBe(
      "Failure",
    );
    expect(downloads).toBe(0);
    path = "/home/user/.t3/recordings/owned.mp4";
    expect(yield* recording.getArtifact("bx_23456789", "owned")).toEqual(new Uint8Array([1, 2]));
    expect(downloads).toBe(1);
  }),
);

it.effect("leaves an external encoder untouched during start and stop", () =>
  Effect.gen(function* () {
    let command = "";
    const httpClient = HttpClient.make((request) => {
      if (request.body._tag !== "Uint8Array") return Effect.die(new Error("Missing command"));
      const body: unknown = JSON.parse(new TextDecoder().decode(request.body.body));
      if (
        typeof body !== "object" ||
        body === null ||
        !("command" in body) ||
        typeof body.command !== "string"
      )
        return Effect.die(new Error("Invalid command"));
      command = body.command;
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            ok: true,
            success: true,
            exitCode: 0,
            stderr: "",
            timedOut: false,
            stdout: JSON.stringify({
              recordingId: "owned",
              state: "recording",
              path: "/home/user/.t3/recordings/owned.mp4",
              mimeType: "video/mp4",
            }),
          }),
        ),
      );
    });
    const recording = createBoatRecording(createBoatApiClient({ apiKey: "boat_test", httpClient }));
    yield* recording.start("bx_23456789", "owned");
    const result = NodeChildProcess.execFileSync(
      "python3",
      [
        "-c",
        `import json, pathlib, shlex, sys, tempfile
from unittest.mock import patch
command = shlex.split(sys.stdin.read())
with tempfile.TemporaryDirectory() as temporary:
    root = pathlib.Path(temporary)
    recordings = root / 'recordings'
    recordings.mkdir()
    proc = root / 'proc'
    encoder = proc / '123'
    encoder.mkdir(parents=True)
    encoder.joinpath('cmdline').write_bytes(b'ffmpeg\\0/home/user/external.mp4\\0')
    encoder.joinpath('stat').write_text('123 (ffmpeg) S ' + ' '.join(['0'] * 18) + ' 999')
    program = command[2].replace('/home/user/.t3/recordings', str(recordings)).replace("pathlib.Path('/proc')", "pathlib.Path(" + repr(str(proc)) + ")")
    with patch('subprocess.run', side_effect=AssertionError('Must not invoke helper')), patch('os.kill', side_effect=AssertionError('Must not signal external process')), patch('os.pidfd_open', side_effect=AssertionError('Must not open external process')):
        with patch.object(sys, 'argv', ['recording', 'start', 'owned']):
            try:
                namespace = {}
                try:
                    exec(program, namespace)
                finally:
                    namespace['lock'].close()
            except RuntimeError as error:
                assert 'external recorder' in str(error)
            else:
                raise AssertionError('External recorder accepted')
        recordings.joinpath('owned.json').write_text(json.dumps({'pid': 123, 'started': '999'}))
        with patch.object(sys, 'argv', ['recording', 'stop', 'owned']):
            namespace = {}
            try:
                exec(program, namespace)
            finally:
                namespace['lock'].close()
`,
      ],
      { input: command, encoding: "utf8" },
    );
    expect(JSON.parse(result).state).toBe("failed");
  }),
);
