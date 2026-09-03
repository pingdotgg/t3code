import type { Icon } from "./Icons";
import { cn } from "~/lib/utils";

/**
 * Square mark for generic ACP agent instances. The official ACP logo
 * (`ACPRegistryIcon`) is ~2.6:1 and collapses to a sliver in the square slots
 * every other provider glyph fills; this plug mirrors the mobile app's choice.
 */
export const AcpAgentIcon: Icon = ({ className, ...props }) => (
  <svg
    {...props}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={cn("text-black dark:text-white", className)}
  >
    <path d="M12 22v-5" />
    <path d="M9 8V2" />
    <path d="M15 8V2" />
    <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
  </svg>
);
