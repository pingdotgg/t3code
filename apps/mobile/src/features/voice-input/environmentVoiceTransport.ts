import { File, UploadType } from "expo-file-system";
import type { EnvironmentVoiceTranscriptionTransport } from "@t3tools/client-runtime/voice-input";

export const environmentVoiceTransport: EnvironmentVoiceTranscriptionTransport = {
  sizeBytes: async (uri) => new File(uri).size,
  upload: async ({ uri, url, mimeType, signal }) => {
    const result = await new File(uri).upload(url, {
      httpMethod: "POST",
      uploadType: UploadType.BINARY_CONTENT,
      headers: { "Content-Type": mimeType },
      signal,
    });
    return { status: result.status, bodyText: result.body };
  },
};
