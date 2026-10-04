import { useCallback, useRef, useState } from "react";
import {
  voiceInputBlocksSubmission,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";

/** Send handlers also read the ref: a shortcut can run before React renders the disabled button. */
export function useDictationSubmission(ownerKey: string) {
  const active = useRef({ ownerKey, blocked: false });
  const [state, setState] = useState({ ownerKey, blocked: false });
  const onStateChange = useCallback((owner: string, voice: VoiceInputState) => {
    const blocked = voiceInputBlocksSubmission(voice);
    if (!blocked && active.current.ownerKey !== owner) return;
    active.current = { ownerKey: owner, blocked };
    setState(active.current);
  }, []);
  const isSubmissionBlocked = useCallback(
    () => active.current.ownerKey === ownerKey && active.current.blocked,
    [ownerKey],
  );
  return {
    blocked: state.ownerKey === ownerKey && state.blocked,
    isSubmissionBlocked,
    onStateChange,
  };
}
