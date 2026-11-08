import { useAtomSet } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { updateMobilePreferencesAtom } from "../../state/preferences";
import { SettingsSection } from "../settings/components/SettingsSection";
import { useReadAloudServerUrl, useReadAloudVoice } from "./ReadAloudButton";
import { startReadAloud, stopReadAloud, useReadAloudState } from "./readAloudPlayer";
import { fetchReadAloudVoices, readAloudVoiceLabel, type ReadAloudVoice } from "./readAloudServer";

const SAMPLE_ID = "settings:read-aloud-sample";
const SAMPLE_TEXT = "Here's how replies will sound when you press the speaker button.";

type VoiceList =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly voices: ReadonlyArray<ReadAloudVoice> }
  | { readonly status: "error"; readonly message: string };

/** Voice picker for the speaker button. Tapping a voice picks it and plays a sample. */
export function ReadAloudVoiceSection(props: { readonly environmentId: EnvironmentId | null }) {
  const serverUrl = useReadAloudServerUrl(props.environmentId);
  const voice = useReadAloudVoice();
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const readAloud = useReadAloudState();
  const [fetched, setFetched] = useState<{
    readonly serverUrl: string;
    readonly list: VoiceList;
  } | null>(null);
  const [showAll, setShowAll] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the PC's read-aloud server for its voice list once while this settings page is open.
  useEffect(() => {
    if (!serverUrl) return;
    let cancelled = false;
    fetchReadAloudVoices(serverUrl).then(
      (voices) => {
        if (!cancelled) setFetched({ serverUrl, list: { status: "ready", voices } });
      },
      (error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setFetched({ serverUrl, list: { status: "error", message } });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [serverUrl]);

  const list: VoiceList = !serverUrl
    ? { status: "error", message: "Connect to your PC to choose a voice." }
    : fetched?.serverUrl === serverUrl
      ? fetched.list
      : { status: "loading" };
  const voices = list.status === "ready" ? list.voices : [];
  const usVoices = voices.filter((option) => option.shortName.startsWith("en-US-"));
  const shown = showAll || usVoices.length === 0 ? voices : usVoices;
  const choices = shown.some((option) => option.shortName === voice)
    ? shown
    : [{ shortName: voice, gender: "", personalities: "" }, ...shown];
  const sampling = readAloud.messageId === SAMPLE_ID && readAloud.status !== "idle";

  return (
    <>
      <SettingsSection title="Read aloud voice">
        {choices.map((option, index) => (
          <ListChoiceRow
            key={option.shortName}
            label={readAloudVoiceLabel(option.shortName)}
            description={
              [option.gender, option.personalities].filter(Boolean).join(" · ") || undefined
            }
            selected={option.shortName === voice}
            separated={index > 0}
            onPress={() => {
              savePreferences({ readAloudVoice: option.shortName });
              void startReadAloud({
                messageId: SAMPLE_ID,
                markdown: SAMPLE_TEXT,
                serverUrl,
                voice: option.shortName,
              });
            }}
          />
        ))}
        {list.status === "ready" && usVoices.length > 0 && usVoices.length < voices.length ? (
          <ListActionRow
            label={showAll ? "Show US voices only" : "Show all English voices"}
            onPress={() => setShowAll((value) => !value)}
          />
        ) : null}
        {sampling ? <ListActionRow label="Stop sample" onPress={stopReadAloud} /> : null}
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        {list.status === "loading"
          ? "Loading voices from your PC…"
          : list.status === "error"
            ? list.message
            : "The speaker button on replies reads them with Microsoft Edge's natural voices, made on your PC by its read-aloud server and streamed here. The reply text is sent to Microsoft. Tap a voice to hear it."}
        {readAloud.messageId === SAMPLE_ID && readAloud.error ? `\n${readAloud.error}` : null}
      </Text>
    </>
  );
}
