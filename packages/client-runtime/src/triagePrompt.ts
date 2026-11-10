import { TRIAGE_PROMPT_FILE_NAME } from "@t3tools/contracts";

const PLAYBOOK_LINK_START = `[${TRIAGE_PROMPT_FILE_NAME}](`;

// Link destinations are URI-encoded, so the first ")" after the start closes the link.
const playbookLinkRange = (prompt: string) => {
  const start = prompt.indexOf(PLAYBOOK_LINK_START);
  if (start < 0) return null;
  const close = prompt.indexOf(")", start + PLAYBOOK_LINK_START.length);
  return close < 0 ? null : { start, end: close + 1 };
};

/** A draft is a triage draft while its message still links the playbook file. */
export const isTriagePrompt = (prompt: string) => prompt.includes(PLAYBOOK_LINK_START);

/**
 * Swaps the playbook link in `prompt` for the one in `preparedPrompt`, the
 * prompt another machine prepared, keeping everything the user wrote.
 */
export const relinkTriagePlaybook = (prompt: string, preparedPrompt: string) => {
  const from = playbookLinkRange(prompt);
  const to = playbookLinkRange(preparedPrompt);
  if (from === null || to === null) return prompt;
  return (
    prompt.slice(0, from.start) + preparedPrompt.slice(to.start, to.end) + prompt.slice(from.end)
  );
};
