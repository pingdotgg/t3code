import { createTranscriptionEnvironmentAtoms } from "@t3tools/client-runtime/state/transcription";

import { connectionAtomRuntime } from "../connection/runtime";

export const transcriptionEnvironment = createTranscriptionEnvironmentAtoms(connectionAtomRuntime);
