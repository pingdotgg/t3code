import type { BoatApiClient } from "@t3tools/boat";
import { SandboxRecording, SandboxRecordingId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CloudSandboxError, type RecordingSandbox } from "../../driver.ts";

const decodeId = Schema.decodeUnknownEffect(SandboxRecordingId);
const decodeRecording = Schema.decodeUnknownEffect(Schema.fromJsonString(SandboxRecording));
const PROGRAM = `import fcntl, json, os, pathlib, signal, subprocess, sys, time
operation, recording_id = sys.argv[1:]
directory = pathlib.Path('/home/user/.t3/recordings')
directory.mkdir(parents=True, exist_ok=True, mode=0o700)
lock = directory.joinpath('recorder.lock').open('a')
fcntl.flock(lock, fcntl.LOCK_EX)
artifact = directory / (recording_id + '.mp4')
metadata = directory / (recording_id + '.json')
def process_identity(pid, require_artifact=True):
    try:
        root = pathlib.Path('/proc') / str(pid)
        args = root.joinpath('cmdline').read_bytes().split(b'\\0')
        if not args or pathlib.Path(os.fsdecode(args[0])).name != 'ffmpeg':
            return None
        if require_artifact and os.fsencode(str(artifact)) not in args:
            return None
        stat = root.joinpath('stat').read_text().rsplit(')', 1)[1].split()
        if stat[0] == 'Z':
            return None
        return stat[19]
    except (OSError, IndexError):
        return None
def owned_process(data):
    return isinstance(data.get('pid'), int) and data['pid'] > 0 and isinstance(data.get('started'), str) and process_identity(data['pid']) == data['started']
if metadata.exists():
    data = json.loads(metadata.read_text())
else:
    data = {}
if operation == 'start':
    if not data:
        if artifact.exists():
            raise RuntimeError('Recording output already exists without ownership metadata')
        if any(process_identity(int(p.name), False) for p in pathlib.Path('/proc').iterdir() if p.name.isdigit()):
            raise RuntimeError('An encoder is already running; refusing to replace an external recorder')
        subprocess.run(['ascii-record-desktop', 'start', str(artifact)], check=True, stdout=subprocess.DEVNULL)
        for attempt in range(50):
            for candidate in pathlib.Path('/proc').iterdir():
                if candidate.name.isdigit():
                    started = process_identity(int(candidate.name))
                    if started:
                        data = {'pid': int(candidate.name), 'started': started}
                        break
            if data:
                break
            time.sleep(0.1)
        if not data:
            raise RuntimeError('Recorder did not expose an owned encoder process')
        temporary = metadata.with_suffix('.next')
        temporary.write_text(json.dumps(data))
        temporary.replace(metadata)
    elif not owned_process(data):
        raise RuntimeError('Recording ID has already been used')
if not data:
    raise RuntimeError('Recording is not owned by T3')
if operation == 'stop' and owned_process(data):
    handle = os.pidfd_open(data['pid'])
    try:
        if owned_process(data):
            signal.pidfd_send_signal(handle, signal.SIGINT)
    finally:
        os.close(handle)
    for attempt in range(300):
        if not owned_process(data):
            break
        time.sleep(0.1)
    if owned_process(data):
        raise RuntimeError('Recorder did not finalize the MP4')
state = 'recording' if owned_process(data) else 'failed'
if state != 'recording' and artifact.exists() and artifact.stat().st_size > 0:
    probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_type:format=format_name', '-of', 'json', str(artifact)], capture_output=True, timeout=10)
    if probe.returncode == 0:
        media = json.loads(probe.stdout)
        if 'mp4' in media.get('format', {}).get('format_name', '').split(',') and any(stream.get('codec_type') == 'video' for stream in media.get('streams', [])):
            state = 'completed'
print(json.dumps({'recordingId': recording_id, 'state': state, 'path': str(artifact), 'mimeType': 'video/mp4'}))
`;

export function createBoatRecording(client: BoatApiClient): RecordingSandbox {
  const run = Effect.fn("BoatCloudSandboxDriver.recording")(function* (
    sandboxId: string,
    recordingId: string,
    operation: "start" | "status" | "stop",
  ) {
    const id = yield* decodeId(recordingId).pipe(
      Effect.mapError((cause) => new CloudSandboxError({ reason: "configuration", cause })),
    );
    const command = `python3 -c '${PROGRAM.replaceAll("'", "'\\''")}' ${operation} ${id}`;
    const result = yield* client
      .runCommand(sandboxId, command)
      .pipe(Effect.mapError((cause) => new CloudSandboxError({ reason: "unavailable", cause })));
    if (!result.success || result.exitCode !== 0 || result.timedOut)
      return yield* new CloudSandboxError({
        reason: "unavailable",
        cause: new Error("The owned desktop recording operation failed."),
      });
    return yield* decodeRecording(result.stdout.trim()).pipe(
      Effect.mapError((cause) => new CloudSandboxError({ reason: "configuration", cause })),
      Effect.filterOrFail(
        (recording) =>
          recording.recordingId === id && recording.path === `/home/user/.t3/recordings/${id}.mp4`,
        () =>
          new CloudSandboxError({
            reason: "configuration",
            cause: new Error("Recording identity changed."),
          }),
      ),
    );
  });
  return {
    start: (sandboxId, recordingId) => run(sandboxId, recordingId, "start"),
    status: (sandboxId, recordingId) => run(sandboxId, recordingId, "status"),
    stop: (sandboxId, recordingId) => run(sandboxId, recordingId, "stop"),
    getArtifact: Effect.fn("BoatCloudSandboxDriver.recording.getArtifact")(
      function* (sandboxId, recordingId) {
        const recording = yield* run(sandboxId, recordingId, "status");
        if (recording.state !== "completed")
          return yield* new CloudSandboxError({
            reason: "configuration",
            cause: new Error("Stop the recording before downloading it."),
          });
        return yield* client
          .getArtifact(sandboxId, recording.path)
          .pipe(
            Effect.mapError((cause) => new CloudSandboxError({ reason: "unavailable", cause })),
          );
      },
    ),
  };
}
