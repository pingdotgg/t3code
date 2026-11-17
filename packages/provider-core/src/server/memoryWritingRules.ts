export const MEMORY_WRITING_RULES = [
  "Save knowledge that changes how a future agent should work: standing user preferences and corrections, project constraints, decisions with their reasons, and reusable lessons supported by evidence.",
  "Keep one useful claim per memory. Name its subject and scope; retain the reason, conditions and uncertainty when known. It must make sense without the thread. Do not invent a broader rule to make a task instruction sound durable.",
  "Keep task status, one-off approvals, review limits, branch freezes and temporary workarounds in conversation history. A code description alone is not a memory; retain a non-obvious constraint or reason that reading the code would miss.",
  "A temporary missing dependency or failed tool is not a standing prohibition. Save a demonstrated reusable repair with its trigger, not a lasting claim that the tool cannot be used. Never save secrets.",
  "A user correction about future workflow is worth saving even when it occurs during a single task. Preserve its actual scope: 'for this report' does not mean 'for every report'. An agent proposal, copied brief or acknowledgment is not a user decision.",
] as const;
