import { useEffect, useRef, useState } from "react";
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";

import { pickCurrentLocation } from "../lib/sharedLocation";
import { appendComposerDraftAttachments, getComposerDraftSnapshot } from "./use-composer-drafts";

/** Acquires a fix for the draft that opened the menu, without following navigation or sends. */
export function useComposerLocation(draftKey: string | null, enabled: boolean) {
  const [state, setState] = useState<{ key: string; error: string | null; busy: boolean } | null>(
    null,
  );
  // A cancelled lookup must not become busy again when its draft is revisited.
  if (state !== null && state.key !== draftKey) setState(null);
  const request = useRef<symbol | null>(null);
  const currentKey = useRef(draftKey);
  useEffect(() => {
    currentKey.current = draftKey;
    request.current = null;
    return () => {
      request.current = null;
    };
  }, [draftKey]);

  async function pickLocation() {
    if (!draftKey || !enabled || request.current !== null) return;
    if (
      getComposerDraftSnapshot(draftKey).attachments.length >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS
    ) {
      setState({
        key: draftKey,
        busy: false,
        error: "Remove an attachment before sharing your location.",
      });
      return;
    }
    const token = Symbol();
    request.current = token;
    setState({ key: draftKey, busy: true, error: null });
    try {
      const location = await pickCurrentLocation();
      if (request.current !== token || currentKey.current !== draftKey) return;
      if (appendComposerDraftAttachments(draftKey, [location]) > 0) {
        throw new Error("Remove an attachment before sharing your location.");
      }
      setState({ key: draftKey, busy: false, error: null });
    } catch (error) {
      if (request.current !== token || currentKey.current !== draftKey) return;
      setState({
        key: draftKey,
        busy: false,
        error:
          error instanceof Error ? error.message : "Could not attach your location. Try again.",
      });
    } finally {
      if (request.current === token) request.current = null;
    }
  }

  return {
    pickLocation,
    busy: state?.key === draftKey ? state.busy : false,
    error: state?.key === draftKey ? state.error : null,
  };
}
