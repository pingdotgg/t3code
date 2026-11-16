import { useAtomValue } from "@effect/atom-react";
import { getElevenLabsSpeechVoices } from "@t3tools/client-runtime/voice-input";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ElevenLabsVoicePage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Atom, AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { usePreparedConnection, useEnvironmentScope } from "../state/session";
import { inEnvironmentSpeechRuntime } from "./runEnvironmentSpeech";

function query(prepared: PreparedConnection | null, pageToken?: string) {
  return Atom.make(
    prepared
      ? inEnvironmentSpeechRuntime(
          getElevenLabsSpeechVoices(prepared, pageToken ? { pageToken } : {}),
        )
      : Effect.succeed(null),
  );
}
export function useElevenLabsVoices(environmentId: EnvironmentId) {
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const prepared = Option.getOrNull(usePreparedConnection(environmentId));
  const connection = canRead ? prepared : null;
  const make = () => ({
    prepared: connection,
    previous: [] as ElevenLabsVoicePage["voices"],
    atom: query(connection),
  });
  const [current, setCurrent] = useState(make);
  if (current.prepared !== connection) setCurrent(make());
  const result = useAtomValue(current.atom);
  const page = AsyncResult.isSuccess(result) ? result.value : null;
  const voices = [
    ...new Map(
      [...current.previous, ...(page?.voices ?? [])].map((voice) => [voice.id, voice]),
    ).values(),
  ];
  return {
    voices,
    loading: AsyncResult.isInitial(result) || result.waiting,
    failed: AsyncResult.isFailure(result),
    connected: connection !== null,
    hasMore: Boolean(page?.nextPageToken),
    refresh: () => setCurrent(make()),
    loadMore: () => {
      if (page?.nextPageToken)
        setCurrent({
          prepared: connection,
          previous: voices,
          atom: query(connection, page.nextPageToken),
        });
    },
  };
}
