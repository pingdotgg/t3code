/** Creation is opt-in. An uncertain utterance may clarify, never silently
 * allocate a new conversation as a substitute for an existing target. */
export const allowsThreadCreation = (text: string) =>
  (/\b(?:create|make|start)(?: me)? (?:a |another |new |separate )(?:new |separate )?thread\b/i.test(
    text,
  ) ||
    /\bopen(?: me)? (?:a )?(?:new|another|separate) thread\b/i.test(text)) &&
  !/\b(?:not|don't|dont|never|instead of)\b/i.test(text);

/** Hold the model's audio while an imperative UI request is being resolved.
 * The dispatcher releases the hold for questions, errors and substantive work. */
export const isUiCommandPrefix = (text: string) =>
  /^(?:(?:please|can you|could you)\s+)?(?:open|show|switch|go|navigate|make|create|start)\b/i.test(
    text.trim(),
  );
