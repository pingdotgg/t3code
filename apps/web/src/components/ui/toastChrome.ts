import { Spinner } from "~/components/ui/spinner";

import { Toast } from "@base-ui/react/toast";
import {
  useEffect,
  useState,
  type CSSProperties,
  type ComponentPropsWithoutRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { type ScopedThreadRef, type ThreadId } from "@t3tools/contracts";
import { CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { Check, ChevronDown, ChevronUp, Copy } from "lucide";

import { cn } from "~/lib/utils";
import { Button, buttonVariants } from "~/components/ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import {
  buildVisibleToastLayout,
  hasVisibleToastAction,
  shouldHideCollapsedToastContent,
  shouldRenderThreadScopedToast,
} from "./toast.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";
import { useThreadRouteTarget } from "~/hooks/useThreadRouteTarget";

export const TOAST_ICONS = {
  error: CircleAlertIcon,
  info: InfoIcon,
  loading: Spinner,
  success: CircleCheckIcon,
  warning: TriangleAlertIcon,
} as const;

export const ERROR_DESCRIPTION_CLAMP_MIN_CHARS = 180;
export function errorDescriptionClampClass(type: unknown, description: unknown): string | undefined {
  if (type !== "error" || typeof description !== "string") {
    return undefined;
  }
  if (description.length < ERROR_DESCRIPTION_CLAMP_MIN_CHARS) {
    return undefined;
  }
  return "line-clamp-4";
}

