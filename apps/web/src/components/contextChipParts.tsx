import type { EnvironmentId, PullRequestContextMetadata } from "@t3tools/contracts";
import { CircleDashedIcon, FilmIcon, ImageIcon } from "lucide-react";
import {
  useState,
  type ComponentProps,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";

import { PULL_REQUEST_STATE_PRESENTATION } from "~/components/pullRequest/pullRequestIcons";
import type { PullRequestContextDisplayState } from "~/lib/composerContextRecords";
import { PierreEntryIcon } from "./chat/PierreEntryIcon";
import { middleTruncateAttachmentName } from "./composerInlineChip";
import { PullRequestContextDetails } from "./PullRequestContextDetails";
import { ContextChip, ContextChipLabel, type ContextChipKind } from "./ContextChip";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "./ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { PullRequestLinkPreview } from "./pullRequest/PullRequestLinkPreview";
import { usePullRequestPreviewTarget } from "~/lib/openPullRequestLink";

/** ContextChip kind for a pull request context in each display state. */
export const PULL_REQUEST_CHIP_KINDS = {
  open: "pr-open",
  draft: "pr-draft",
  merged: "pr-merged",
  closed: "pr-closed",
  unknown: "pull-request",
} as const satisfies Record<PullRequestContextDisplayState | "unknown", ContextChipKind>;

/** A static chip with an optional tooltip; each surface keeps ownership of payload lookup. */
export function ContextChipShell({
  icon,
  label,
  tooltip,
  ...props
}: Omit<ComponentProps<typeof ContextChip>, "className" | "render"> & {
  icon: ReactNode;
  label: string;
  /** Newlines in the tooltip are kept. */
  tooltip?: ReactNode;
}) {
  const chip = (
    <ContextChip
      data-context-unresolved={props.state === "unresolved" ? "true" : undefined}
      tabIndex={tooltip ? 0 : undefined}
      {...props}
    >
      {icon}
      <ContextChipLabel>{label}</ContextChipLabel>
    </ContextChip>
  );
  if (!tooltip) return chip;
  return (
    <Tooltip>
      <TooltipTrigger render={chip} />
      <TooltipPopup side="top" className="whitespace-pre-wrap">
        {tooltip}
      </TooltipPopup>
    </Tooltip>
  );
}

/** A chip that opens its details in a popover; the chip itself is the trigger. */
export function ContextChipPopover(props: {
  kind: ContextChipKind;
  icon: ReactNode;
  label: string;
  copyMarkdown?: string;
  accessibleLabel: string;
  children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <ContextChip
            kind={props.kind}
            render={<button type="button" />}
            aria-label={`${props.accessibleLabel}. Show details`}
            data-markdown-copy={props.copyMarkdown}
          />
        }
      >
        {props.icon}
        <ContextChipLabel>{props.label}</ContextChipLabel>
      </PopoverTrigger>
      <PopoverPopup side="top" width="lg" padding="compact">
        <PopoverTitle className="sr-only">{props.accessibleLabel}</PopoverTitle>
        {props.children}
      </PopoverPopup>
    </Popover>
  );
}

export function PullRequestChip(props: {
  metadata: PullRequestContextMetadata;
  environmentId: EnvironmentId | null;
  label: string;
  kindLabel: string;
  kind: ContextChipKind;
  copyMarkdown?: string;
  onOpen: (event: MouseEvent<HTMLElement>, url: string) => void;
}) {
  const previewTarget = usePullRequestPreviewTarget(props.environmentId, props.metadata.url);
  const displayState =
    props.metadata.state === "open" && props.metadata.isDraft ? "draft" : props.metadata.state;
  const StateIcon = PULL_REQUEST_STATE_PRESENTATION[displayState].Icon;
  const button = (
    <ContextChip
      kind={props.kind}
      render={<button type="button" />}
      aria-label={`Open ${props.kindLabel} ${props.label}: ${props.metadata.title}`}
      data-markdown-copy={props.copyMarkdown}
      onClick={(event) => props.onOpen(event, props.metadata.url)}
    >
      <StateIcon />
      <ContextChipLabel>{props.label}</ContextChipLabel>
    </ContextChip>
  );
  if (previewTarget !== null) {
    return (
      <PullRequestLinkPreview
        link={button}
        originalUrl={props.metadata.url}
        target={previewTarget}
        confirmBeforeOpen={false}
        fallback={<PullRequestContextDetails metadata={props.metadata} />}
      />
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipPopup side="top">
        <PullRequestContextDetails metadata={props.metadata} />
      </TooltipPopup>
    </Tooltip>
  );
}

/** Sample the loaded thumbnail once; transparent pixels should not darken its accent. */
function averageImageColor(image: HTMLImageElement): string | undefined {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 16;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(image, 0, 0, 16, 16);
    const { data } = context.getImageData(0, 0, 16, 16);
    let red = 0;
    let green = 0;
    let blue = 0;
    let alpha = 0;
    for (let index = 0; index < data.length; index += 4) {
      const weight = data[index + 3]!;
      red += data[index]! * weight;
      green += data[index + 1]! * weight;
      blue += data[index + 2]! * weight;
      alpha += weight;
    }
    if (alpha === 0) return;
    return `rgb(${Math.round(red / alpha)} ${Math.round(green / alpha)} ${Math.round(blue / alpha)})`;
  } catch {
    // Cross-origin or unavailable pixels keep the default image tone and preview action.
    return;
  }
}

export function ImageChipButton({
  name,
  previewUrl,
  size,
  suffix,
  style,
  ...props
}: Omit<ComponentProps<typeof ContextChip>, "kind" | "render"> & {
  name: string;
  previewUrl: string | undefined;
  /** Every attachment chip reports its size; images are no exception. */
  size: string;
  suffix?: string | null;
}) {
  const [sample, setSample] = useState<{ url: string; color: string | undefined }>();
  const [corsFailedUrl, setCorsFailedUrl] = useState<string>();
  const accent = sample?.url === previewUrl ? sample?.color : undefined;
  return (
    <ContextChip
      kind="image"
      render={<button type="button" />}
      aria-label={`Image attachment, ${name}, ${size}`}
      style={{ ...style, ...(accent ? { "--context-chip-accent": accent } : {}) } as CSSProperties}
      {...props}
    >
      {previewUrl ? (
        <img
          key={previewUrl}
          crossOrigin={corsFailedUrl === previewUrl ? undefined : "anonymous"}
          src={previewUrl}
          alt=""
          className="size-[1.17em] shrink-0 rounded-sm object-cover"
          onError={() => setCorsFailedUrl(previewUrl)}
          onLoad={(event) =>
            setSample({ url: previewUrl, color: averageImageColor(event.currentTarget) })
          }
        />
      ) : (
        <ImageIcon />
      )}
      <ContextChipLabel className="max-w-72">{middleTruncateAttachmentName(name)}</ContextChipLabel>
      <span className="shrink-0 text-3xs text-current">{size}</span>
      {suffix ? <span className="text-3xs text-current">{suffix}</span> : null}
    </ContextChip>
  );
}

export function FileChip(props: {
  name: string;
  size: string;
  isVideo: boolean;
  theme: "light" | "dark";
  accessibleLabel: string;
  tooltip: string;
  suffix?: string | null;
  copyMarkdown?: string;
  disabled?: boolean;
  error?: boolean;
  unresolved?: boolean;
  onOpen?: (() => void) | undefined;
}) {
  const content = <FileChipContent {...props} />;
  const state = props.unresolved
    ? ("unresolved" as const)
    : props.error
      ? ("invalid" as const)
      : null;
  const attributes = {
    kind: props.isVideo ? "video" : "file",
    ...(state ? { state } : {}),
    "aria-label": [props.accessibleLabel, props.suffix].filter(Boolean).join(", "),
    "data-markdown-copy": props.copyMarkdown,
    "data-context-unresolved": props.unresolved ? "true" : undefined,
  } as const;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          props.onOpen ? (
            <ContextChip
              render={<button type="button" disabled={props.disabled} />}
              onClick={props.onOpen}
              {...attributes}
            >
              {content}
            </ContextChip>
          ) : (
            <ContextChip tabIndex={0} {...attributes}>
              {content}
            </ContextChip>
          )
        }
      />
      <TooltipPopup side="top" className="whitespace-pre-wrap">
        {props.tooltip}
      </TooltipPopup>
    </Tooltip>
  );
}

function FileChipContent(props: {
  name: string;
  size: string;
  isVideo: boolean;
  theme: "light" | "dark";
  suffix?: string | null;
}) {
  return (
    <>
      {props.isVideo ? (
        <FilmIcon />
      ) : (
        <PierreEntryIcon pathValue={props.name} kind="file" theme={props.theme} />
      )}
      <ContextChipLabel className="max-w-72">
        {middleTruncateAttachmentName(props.name)}
      </ContextChipLabel>
      <span className="shrink-0 text-3xs text-current">{props.size}</span>
      {props.suffix ? <span className="text-3xs text-current">{props.suffix}</span> : null}
    </>
  );
}

export function UnresolvedChip(props: { label: string; tooltip: string; copyMarkdown?: string }) {
  return (
    <ContextChipShell
      icon={<CircleDashedIcon />}
      label={props.label}
      state="unresolved"
      aria-label={`Unavailable context, ${props.label}`}
      data-markdown-copy={props.copyMarkdown}
      tooltip={props.tooltip}
    />
  );
}
