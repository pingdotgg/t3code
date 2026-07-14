import type { ModelSelection } from "@t3tools/contracts";

const SUB_AGENT_TITLE_PATTERN = /^agent:\s*/i;
const FAST_MODE_OPTION_ID = "fastMode";
const SERVICE_TIER_OPTION_ID = "serviceTier";
const STANDARD_SERVICE_TIER_ID = "default";

export const isSubAgentThreadTitle = (title: string): boolean =>
  SUB_AGENT_TITLE_PATTERN.test(title.trim());

export const withSubAgentThreadTitle = (title: string): string => {
  const name = title.trim().replace(SUB_AGENT_TITLE_PATTERN, "").trim();
  return `Agent: ${name}`;
};

/**
 * Product-native sub-agent threads always use the standard service tier.
 * Apply this at the orchestration boundary as well as at spawn time so a
 * client cannot re-enable fast mode on a child thread through metadata or a
 * per-turn model selection.
 */
export const enforceSubAgentStandardMode = (selection: ModelSelection): ModelSelection => {
  let changed = false;
  const options = selection.options?.map((option) => {
    if (option.id === FAST_MODE_OPTION_ID && option.value !== false) {
      changed = true;
      return { ...option, value: false };
    }
    if (option.id === SERVICE_TIER_OPTION_ID && option.value !== STANDARD_SERVICE_TIER_ID) {
      changed = true;
      return { ...option, value: STANDARD_SERVICE_TIER_ID };
    }
    return option;
  });

  return changed && options !== undefined ? { ...selection, options } : selection;
};
