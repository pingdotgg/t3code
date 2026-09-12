import * as Effect from "effect/Effect";
import { useEffect, useState } from "react";

import { PrimaryEnvironmentHttpClient } from "../environments/primary/httpClient";
import { runPrimaryHttp } from "../lib/runtime";

/**
 * Server-reported Codex voice availability (`GET /api/voice/availability`).
 *
 * Stale-while-revalidate across composer remounts (the mic remounts per
 * thread): the first mount in the session fetches, later mounts render the
 * cached value instantly and refresh in the background. Failures resolve to
 * `false` so the mic fails closed instead of inviting a doomed recording.
 */

let cachedVoiceAvailability: boolean | null = null;
let inFlightVoiceAvailability: Promise<boolean> | null = null;

function fetchVoiceAvailability(): Promise<boolean> {
  if (!inFlightVoiceAvailability) {
    inFlightVoiceAvailability = runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) => client.voice.availability({ headers: {} })),
        Effect.map((result) => result.codexVoiceAvailable),
      ),
    ).then(
      (available) => {
        cachedVoiceAvailability = available;
        inFlightVoiceAvailability = null;
        return available;
      },
      () => {
        cachedVoiceAvailability = false;
        inFlightVoiceAvailability = null;
        return false;
      },
    );
  }
  return inFlightVoiceAvailability;
}

export function useCodexVoiceAvailability(): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(cachedVoiceAvailability);
  useEffect(() => {
    if (cachedVoiceAvailability !== null) {
      setAvailable(cachedVoiceAvailability);
    }
    let cancelled = false;
    void fetchVoiceAvailability().then((next) => {
      if (!cancelled) setAvailable(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return available;
}
