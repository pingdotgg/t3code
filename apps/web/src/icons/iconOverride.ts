import type { LucideProps } from "lucide-react-original";
import type { ReactElement, Ref } from "react";

/**
 * Hook point for the Conn desktop lab's icon switch. The app build draws no override. The lab
 * swaps this module for apps/lab-gpui/src/icons/iconOverride.tsx (apps/lab-gpui/vite.config.ts).
 */
// oxlint-disable-next-line t3code/no-hookless-use-function -- the lab swaps in a stand-in that calls hooks
export function useIconOverride(
  _name: string,
  _props: Omit<LucideProps, "ref">,
  _ref: Ref<SVGSVGElement>,
  _scoped: boolean,
): ReactElement | null {
  return null;
}
