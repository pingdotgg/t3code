import { VoiceTranscriptionDestination } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { File, Paths } from "expo-file-system";
import * as SecureStore from "expo-secure-store";
import { whenProtectedDataAvailable } from "../../lib/protectedData";

const key = "t3code.voice.audio-grant.v1";
const deviceOnly = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
// Both stores must name the same grant; clearing either one revokes it on the next launch.
const markerFile = () => new File(Paths.document, "voice-audio-grant-id");
const Grant = Schema.Struct({
  id: Schema.NonEmptyString,
  destination: VoiceTranscriptionDestination,
});
export type VoiceGrant = typeof Grant.Type;
const decodeGrant = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.NullOr(Grant)));

export async function readVoiceGrant() {
  await whenProtectedDataAvailable();
  try {
    const raw = await SecureStore.getItemAsync(key, deviceOnly);
    const grant = raw ? decodeGrant(raw) : null;
    return grant && markerFile().textSync() === grant.id ? grant : null;
  } catch {
    return null;
  }
}

export function writeVoiceGrant(grant: VoiceGrant | null) {
  try {
    markerFile().writeSync(grant?.id ?? "");
  } catch (cause) {
    SecureStore.setItem(key, "null", deviceOnly);
    if (grant) throw cause;
    return;
  }
  try {
    SecureStore.setItem(key, JSON.stringify(grant), deviceOnly);
  } catch (cause) {
    if (grant) throw cause;
  }
}
