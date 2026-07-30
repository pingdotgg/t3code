import {
  type ComposerPathSearchTarget,
  useComposerPathSearch as useComposerPathSearchQuery,
} from "../state/queries";

export function useComposerPathSearch(target: ComposerPathSearchTarget) {
  return useComposerPathSearchQuery(target);
}
