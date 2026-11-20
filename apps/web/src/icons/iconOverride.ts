import type { LucideProps } from "lucide-react-original";
import type { ReactElement, Ref } from "react";

/**
 * Hook point for the Conn UI lab's icon switch. The app build draws no override. The lab config
 * swaps this module for src/lab/icons/iconOverride.tsx (vite.lab.config.ts, STUBBED).
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
