import * as Schema from "effect/Schema";
import { File, Paths } from "expo-file-system";
import * as SecureStore from "expo-secure-store";
import { whenProtectedDataAvailable } from "../../lib/protectedData";

const key = "t3code.voice.cleanup-grant.v1";
const deviceOnly = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const markerFile = () => new File(Paths.document, "voice-cleanup-grant-id");
const decodeGrant = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.NullOr(Schema.NonEmptyString)),
);

export async function readVoiceCleanupGrant() {
  await whenProtectedDataAvailable();
  try {
    const raw = await SecureStore.getItemAsync(key, deviceOnly);
    const grant = raw ? decodeGrant(raw) : null;
    return grant && markerFile().textSync() === grant ? grant : null;
  } catch {
    return null;
  }
}

export function writeVoiceCleanupGrant(grant: string | null) {
  try {
    markerFile().writeSync(grant ?? "");
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
