import type { ProviderInteractionMode } from "@forma/contracts";
import { createElement, type ComponentType } from "react";
import {
  IconCursorarrowClick2 as AgentIcon,
  IconEllipsisMessageFill as AskIcon,
} from "symbols-react";
import { cn } from "~/lib/utils";

type ComposerInteractionModeIconProps = {
  className?: string;
};

type ComposerInteractionModeIcon = ComponentType<ComposerInteractionModeIconProps>;

const PlanIcon: ComposerInteractionModeIcon = ({ className }) =>
  createElement(
    "svg",
    {
      viewBox: "0 0 16 16",
      fill: "currentColor",
      className: cn("fill-current", className),
    },
    createElement("path", {
      fillRule: "evenodd",
      clipRule: "evenodd",
      d: "M13.4326 7.26855C13.7913 6.91034 14.3729 6.91004 14.7314 7.26855C15.09 7.62707 15.0897 8.20868 14.7314 8.56738L9.2373 14.0615C8.68102 14.6176 7.94038 14.9516 7.15527 15C7.06762 15.0052 6.99481 14.9324 7 14.8447C7.04846 14.0597 7.38238 13.319 7.93848 12.7627L13.4326 7.26855Z",
    }),
    createElement("path", {
      fillRule: "evenodd",
      clipRule: "evenodd",
      d: "M10.7539 1C12.5465 1 14 2.4535 14 4.24609C13.9998 4.66016 13.6641 4.99609 13.25 4.99609C12.8359 4.99609 12.5002 4.66016 12.5 4.24609C12.5 3.28193 11.7181 2.5 10.7539 2.5H4.25C3.2835 2.5 2.5 3.2835 2.5 4.25V11.7393C2.50006 12.133 2.7992 12.4569 3.18262 12.4961L4.33789 12.5039C4.71592 12.5425 5.01074 12.8618 5.01074 13.25C5.01074 13.6382 4.71592 13.9575 4.33789 13.9961L3.26074 14L3.0293 13.9883C1.88948 13.8723 1.00006 12.9097 1 11.7393V4.25C1 2.45507 2.45507 1 4.25 1H10.7539Z",
    }),
    createElement("path", {
      fillRule: "evenodd",
      clipRule: "evenodd",
      d: "M6.75 8C7.16421 8 7.5 8.33579 7.5 8.75C7.5 9.16421 7.16421 9.5 6.75 9.5H5.25C4.83579 9.5 4.5 9.16421 4.5 8.75C4.5 8.33579 4.83579 8 5.25 8H6.75Z",
    }),
    createElement("path", {
      fillRule: "evenodd",
      clipRule: "evenodd",
      d: "M9.75 5C10.1642 5 10.5 5.33579 10.5 5.75C10.5 6.16421 10.1642 6.5 9.75 6.5H5.25C4.83579 6.5 4.5 6.16421 4.5 5.75C4.5 5.33579 4.83579 5 5.25 5H9.75Z",
    }),
  );

export type ComposerInteractionModeOption = {
  label: string;
  description: string;
  icon: ComposerInteractionModeIcon;
  pillClassName: string;
};

export const composerInteractionModeConfig: Record<
  ProviderInteractionMode,
  ComposerInteractionModeOption
> = {
  default: {
    label: "Agent",
    description: "Explore and implement changes.",
    icon: AgentIcon,
    pillClassName:
      "border-sky-500/35 bg-sky-500/16 text-sky-800 dark:border-sky-400/35 dark:bg-sky-400/18 dark:text-sky-100",
  },
  ask: {
    label: "Ask",
    description: "Read/explain only. No writes.",
    icon: AskIcon,
    pillClassName:
      "border-emerald-500/35 bg-emerald-500/16 text-emerald-800 dark:border-emerald-400/35 dark:bg-emerald-400/18 dark:text-emerald-100",
  },
  plan: {
    label: "Plan",
    description: "Research and propose a plan without implementing.",
    icon: PlanIcon,
    pillClassName:
      "border-amber-500/40 bg-amber-500/20 text-amber-900 dark:border-amber-400/35 dark:bg-amber-400/20 dark:text-amber-50",
  },
};
