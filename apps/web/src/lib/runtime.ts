import * as ManagedRuntime from "effect/ManagedRuntime";

import { remoteHttpClientLayer } from "@t3tools/client-runtime";

export const remoteHttpRuntime = ManagedRuntime.make(remoteHttpClientLayer(globalThis.fetch));
