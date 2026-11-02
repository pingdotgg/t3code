import { create } from "zustand";

import type { DraftId } from "./composerDraftStore";

/**
 * Send on the no-projects home opens a draft without a project and sends the
 * message from it. Whichever opener moves the message into a draft (the hero
 * or the index route racing it) hands that draft over here, and ChatView
 * sends it once its view is ready.
 */
export const useDraftSendOnOpenStore = create<{
  /** The next move of the no-projects home's message also sends it. */
  armed: boolean;
  /** The draft holding the moved message, until ChatView sends it. */
  draftId: DraftId | null;
}>(() => ({ armed: false, draftId: null }));
