import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { File, Paths } from "expo-file-system";

const PENDING_RECORDING_FILE = "voice-pending-recording.json";
const PENDING_RECORDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const PendingVoiceDraftProjectSchema = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  createdAt: Schema.String,
});

const PendingVoiceRecordingSchema = Schema.Struct({
  uri: Schema.NonEmptyString,
  ownerKey: Schema.NonEmptyString,
  label: Schema.NullOr(Schema.String),
  startText: Schema.String,
  selection: Schema.Struct({
    start: Schema.Number,
    end: Schema.Number,
  }),
  grantId: Schema.NullOr(Schema.String),
  recordedAt: Schema.Number,
  project: Schema.optional(PendingVoiceDraftProjectSchema),
});

export type StoredPendingVoiceRecording = typeof PendingVoiceRecordingSchema.Type;

const decodePendingRecording = Schema.decodeUnknownSync(
  Schema.fromJsonString(PendingVoiceRecordingSchema),
);

function manifestFile(): File {
  return new File(Paths.cache, PENDING_RECORDING_FILE);
}

function deleteFileQuietly(file: File): void {
  try {
    if (file.exists) file.delete();
  } catch {}
}

function readRawManifest(file: File): StoredPendingVoiceRecording | null {
  if (!file.exists) return null;
  try {
    return decodePendingRecording(file.textSync());
  } catch {
    return null;
  }
}

export function writePendingVoiceRecording(recording: StoredPendingVoiceRecording | null): void {
  const file = manifestFile();
  if (!recording) {
    deleteFileQuietly(file);
    return;
  }
  const existing = readRawManifest(file);
  const next =
    existing && existing.uri === recording.uri
      ? {
          ...recording,
          recordedAt: existing.recordedAt,
          ...((recording.project ?? existing.project)
            ? { project: recording.project ?? existing.project }
            : {}),
        }
      : recording;
  try {
    file.writeSync(JSON.stringify(next));
  } catch {}
}

export function readPendingVoiceRecording(
  now: number = Date.now(),
): StoredPendingVoiceRecording | null {
  const file = manifestFile();
  if (!file.exists) return null;
  const parsed = readRawManifest(file);
  if (!parsed) {
    deleteFileQuietly(file);
    return null;
  }
  const audioFile = new File(parsed.uri);
  const expired =
    !Number.isFinite(parsed.recordedAt) ||
    now - parsed.recordedAt > PENDING_RECORDING_MAX_AGE_MS ||
    parsed.recordedAt > now + 60_000;
  if (expired || !audioFile.exists) {
    deleteFileQuietly(audioFile);
    deleteFileQuietly(file);
    return null;
  }
  return parsed;
}

export function clearPendingVoiceRecording(deleteAudio = false): void {
  const file = manifestFile();
  if (deleteAudio) {
    const parsed = readRawManifest(file);
    if (parsed) deleteFileQuietly(new File(parsed.uri));
  }
  deleteFileQuietly(file);
}

export function clearPendingVoiceRecordingForUri(uri: string, deleteAudio = false): void {
  const file = manifestFile();
  const parsed = readRawManifest(file);
  if (parsed?.uri === uri) deleteFileQuietly(file);
  if (deleteAudio) deleteFileQuietly(new File(uri));
}
