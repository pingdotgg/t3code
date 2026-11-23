import { TRIAGE_PROMPT_FILE_NAME } from "@t3tools/contracts";

const PLAYBOOK_LINK_START = `[${TRIAGE_PROMPT_FILE_NAME}](`;

/** A draft is a triage draft while its message still links the playbook file. */
export const isTriagePrompt = (prompt: string) => prompt.includes(PLAYBOOK_LINK_START);

// `serializeComposerFileLink` encodes `)` and whitespace, so the first `)` closes the link.
const playbookLinkEnd = (text: string, start: number) => {
  const close = text.indexOf(")", start + PLAYBOOK_LINK_START.length);
  return close === -1 ? null : close + 1;
};

/**
 * Moves a triage draft to the session another machine prepared: each playbook
 * link in `prompt` becomes the link in `preparedPrompt`, and the rest of the
 * text stays. A prompt without the link comes back unchanged.
 */
export function replaceTriagePlaybookLink(prompt: string, preparedPrompt: string): string {
  const preparedStart = preparedPrompt.indexOf(PLAYBOOK_LINK_START);
  const preparedEnd = preparedStart === -1 ? null : playbookLinkEnd(preparedPrompt, preparedStart);
  if (preparedEnd === null) return prompt;
  const link = preparedPrompt.slice(preparedStart, preparedEnd);
  let next = "";
  let cursor = 0;
  while (true) {
    const start = prompt.indexOf(PLAYBOOK_LINK_START, cursor);
    const end = start === -1 ? null : playbookLinkEnd(prompt, start);
    if (end === null) return next + prompt.slice(cursor);
    next += prompt.slice(cursor, start) + link;
    cursor = end;
  }
}
