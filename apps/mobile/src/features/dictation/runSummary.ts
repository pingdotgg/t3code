import { msg } from "gt-react-native";
import { m } from "../../i18n/messages";
import { dictationModelName } from "./dictationModels";
import type { DictationFilterReport } from "./dictationNative";
import type { DictationFallback, DictationRun } from "./dictationStore";

const FALLBACK_REASONS: Record<DictationFallback, string> = {
  "not-downloaded": "the chosen model is not downloaded",
  "warming-up": "the chosen model was still loading",
  failed: "the chosen model failed on this recording",
};

const seconds = (value: number) => `${value.toFixed(1)} s`;

function describeFilter(filter: DictationFilterReport): string {
  if (filter.applied)
    return m(msg("Removed {value} of other voices.", { value: seconds(filter.droppedSeconds) }));
  switch (filter.skipped) {
    case "onlyYou":
      return m(msg("Only your voice was heard."));
    case "noMatch":
      return m(msg("Your voice was not recognised, so nothing was removed."));
    case "similarLevel":
      return m(msg("Another voice was as loud as yours, so nothing was removed."));
    case "mostlyOther":
      return m(msg("Most of the recording did not match your voice, so nothing was removed."));
    case "noProfile":
      return m(msg("No voice profile is recorded, so nothing was removed."));
    case "notInstalled":
      return m(msg("The voice filter is not downloaded, so nothing was removed."));
    case "tooShort":
      return m(msg("The recording was too short to filter."));
    case "noSpeech":
      return m(msg("No speech was found to filter."));
    default:
      return m(msg("The voice filter left this recording as it was."));
  }
}

/** One line on what the last dictation ran on, for Settings. */
export function describeRun(run: DictationRun): string {
  const engine = dictationModelName(run.engine);
  const timing =
    run.audioSeconds === null
      ? seconds(run.processingSeconds)
      : `${seconds(run.processingSeconds)} for ${seconds(run.audioSeconds)} of audio`;
  const reason = run.fallback === null ? "" : `, because ${FALLBACK_REASONS[run.fallback]}`;
  const filter = run.filter === null ? "" : ` ${describeFilter(run.filter)}`;
  return m(msg("{engine}{reason}. Took {timing}.{filter}", { engine, reason, timing, filter }));
}
