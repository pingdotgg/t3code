import { RefreshIcon } from "~/components/ui/refresh-icon";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  ExternalLink,
  MousePointerClick,
  PictureInPicture2,
  Search,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useState,
} from "react";
import { T, useGT } from "gt-react";

import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { ToolbarGroup } from "../ToolbarGroup";

interface Props {
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  refreshDisabled: boolean;
  inputDisabled?: boolean | undefined;
  /** Owned by the caller so its shortcut handler can focus the address bar directly. */
  urlInputRef: RefObject<HTMLInputElement | null>;
  onBack: () => void;
  onForward: () => void;
  onRefresh: () => void;
  onStopLoading: () => void;
  onSubmit: (url: string) => void;
  /** When provided, renders an "Open in browser" affordance to the right. */
  onOpenInBrowser?: (() => void) | undefined;
  onCapture?: ((record: boolean) => void) | undefined;
  captureDisabled?: boolean | undefined;
  recording?: boolean | undefined;
  onPictureInPicture?: (() => void) | undefined;
  pictureInPicture?: boolean | undefined;
  pictureInPictureDisabled?: boolean | undefined;
  /**
   * When provided, renders an annotation-mode toggle button to the right of
   * the URL input. Pressed while annotation mode is active (button shows in `pressed`
   * state). Disabled in `pickDisabled` mode.
   */
  onPickElement?: (() => void) | undefined;
  pickActive?: boolean | undefined;
  pickDisabled?: boolean | undefined;
  /** Optional reason string surfaced in the disabled tooltip. */
  pickDisabledReason?: string | undefined;
  /** rooms-patches: browser annotations control, rendered right after the picker. */
  annotationAction?: ReactNode;
  /** The saved-login key, shown inside the address bar's trailing edge. */
  credentialAction?: ReactNode;
  /** Stream ownership status and take/release controls share the browser toolbar. */
  controlAction?: ReactNode;
  /**
   * Trailing slot rendered after the URL input. Used by the preview view
   * to mount the three-dot menu (hard reload, devtools, zoom, clear data).
   */
  trailingActions?: ReactNode;
  /**
   * Slot between the nav buttons and the URL input. The preview view uses it
   * to name the tab's browser profile, which is otherwise invisible.
   */
  leadingActions?: ReactNode;
}

const NOOP = () => {};

export function PreviewChromeRow({
  url,
  loading,
  canGoBack,
  canGoForward,
  refreshDisabled,
  inputDisabled,
  urlInputRef: inputRef,
  onBack,
  onForward,
  onRefresh,
  onStopLoading,
  onSubmit,
  onOpenInBrowser,
  onCapture,
  captureDisabled,
  recording,
  onPictureInPicture,
  pictureInPicture,
  pictureInPictureDisabled,
  onPickElement,
  pickActive,
  pickDisabled,
  pickDisabledReason,
  trailingActions,
  leadingActions,
  annotationAction,
  credentialAction,
  controlAction,
}: Props) {
  const gt = useGT();
  const [draft, setDraft] = useState(url);
  const [inputFocused, setInputFocused] = useState(false);

  const submit = (event?: FormEvent | KeyboardEvent) => {
    event?.preventDefault();
    const next = draft.trim();
    if (next.length === 0) return;
    onSubmit(next);
    inputRef.current?.blur();
  };

  return (
    <div className="relative">
      <form
        onSubmit={submit}
        className="mb-0! flex h-10 min-h-10 shrink-0 items-center gap-2 border-b border-(--shell-divider)! bg-background px-2 in-data-[preview-panel-mode=inline]:h-auto in-data-[preview-panel-mode=inline]:min-h-0 in-data-[preview-panel-mode=inline]:py-toolbar"
        data-surface-subheader
      >
        <ToolbarGroup role="group" aria-label={gt("Navigation")}>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={canGoBack ? onBack : NOOP}
                  disabled={!canGoBack}
                  aria-label={gt("Back", { $context: "browser navigation" })}
                  type="button"
                />
              }
            >
              <ArrowLeft />
            </TooltipTrigger>
            <TooltipPopup>
              <T context="browser navigation">Back</T>
            </TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={canGoForward ? onForward : NOOP}
                  disabled={!canGoForward}
                  aria-label={gt("Forward", { $context: "browser navigation" })}
                  type="button"
                />
              }
            >
              <ArrowRight />
            </TooltipTrigger>
            <TooltipPopup>
              <T context="browser navigation">Forward</T>
            </TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={refreshDisabled ? NOOP : loading ? onStopLoading : onRefresh}
                  disabled={refreshDisabled}
                  aria-label={
                    loading ? gt("Stop", { $context: "stop loading the page" }) : gt("Refresh")
                  }
                  type="button"
                />
              }
            >
              <RefreshIcon refreshing={loading} />
            </TooltipTrigger>
            <TooltipPopup>
              {loading ? gt("Stop", { $context: "stop loading the page" }) : gt("Refresh")}
            </TooltipPopup>
          </Tooltip>
        </ToolbarGroup>

        {leadingActions}

        <InputGroup variant="soft" className="group/address h-8 min-w-0 flex-1">
          <InputGroupAddon>
            <Search aria-hidden />
          </InputGroupAddon>
          <Tooltip>
            <TooltipTrigger
              render={
                <InputGroupInput
                  ref={inputRef}
                  value={inputFocused ? draft : url}
                  onChange={(event) => setDraft(event.target.value)}
                  onFocus={() => {
                    setDraft(url);
                    setInputFocused(true);
                    queueMicrotask(() => inputRef.current?.select());
                  }}
                  onBlur={() => {
                    setInputFocused(false);
                  }}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing || event.keyCode === 229) {
                      // A trusted Enter would still submit the form implicitly.
                      if (event.key === "Enter") event.preventDefault();
                      return;
                    }
                    if (event.key === "Enter") submit(event);
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setDraft(url);
                      inputRef.current?.blur();
                    }
                  }}
                  placeholder={gt("Search or enter URL")}
                  aria-label={gt("Search or enter URL")}
                  data-workspace-focus-default
                  spellCheck={false}
                  disabled={inputDisabled}
                  data-preview-url-input
                  size="sm"
                />
              }
            />
          </Tooltip>
          {/* Keep the login menu and its selection mounted when address-bar focus changes. */}
          {credentialAction ? (
            <InputGroupAddon align="inline-end">{credentialAction}</InputGroupAddon>
          ) : null}
          {onOpenInBrowser && !inputFocused ? (
            <InputGroupAddon align="inline-end">
              {/* Revealed on hover so a resting address bar reads as plain text. */}
              <span className="pointer-events-none flex opacity-0 transition-opacity focus-within:pointer-events-auto focus-within:opacity-100 group-hover/address:pointer-events-auto group-hover/address:opacity-100">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={onOpenInBrowser}
                        aria-label={gt("Open in system browser")}
                        type="button"
                      />
                    }
                  >
                    <ExternalLink />
                  </TooltipTrigger>
                  <TooltipPopup>
                    <T>Open in system browser</T>
                  </TooltipPopup>
                </Tooltip>
              </span>
            </InputGroupAddon>
          ) : null}
        </InputGroup>

        {controlAction ? (
          <div className="flex shrink-0 items-center gap-2">{controlAction}</div>
        ) : null}

        <ToolbarGroup className="shrink-0 empty:hidden">
          {onPickElement ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant={pickActive ? "secondary" : "ghost"}
                    size="icon-xs"
                    onClick={onPickElement}
                    disabled={pickDisabled}
                    aria-label={pickActive ? "Cancel annotation" : "Annotate preview"}
                    aria-pressed={pickActive ? "true" : "false"}
                    type="button"
                  />
                }
              >
                <MousePointerClick className={cn(pickActive && "text-primary")} />
              </TooltipTrigger>
              <TooltipPopup>
                {pickDisabled && pickDisabledReason
                  ? pickDisabledReason
                  : pickActive
                    ? "Cancel annotation (Esc)"
                    : "Annotate elements, regions, and drawings"}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {annotationAction}
          {onCapture ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant={recording ? "secondary" : "ghost"}
                    size="icon-xs"
                    onClick={(event) => onCapture(event.shiftKey)}
                    aria-label={recording ? gt("Stop recording") : gt("Capture screenshot")}
                    type="button"
                    className="relative"
                    disabled={captureDisabled}
                  />
                }
              >
                <Camera className={cn(recording && "text-destructive")} />
                {recording ? (
                  <span className="absolute right-0.5 top-0.5 size-1.5 motion-safe:animate-status-pulse rounded-full bg-destructive" />
                ) : null}
              </TooltipTrigger>
              <TooltipPopup>
                {recording ? gt("Stop recording") : gt("Screenshot · Shift-click to record")}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {onPictureInPicture ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant={pictureInPicture ? "secondary" : "ghost"}
                    size="icon-xs"
                    onClick={onPictureInPicture}
                    aria-label={
                      pictureInPicture
                        ? gt("Close floating preview")
                        : gt("Float preview over chat")
                    }
                    aria-pressed={pictureInPicture ? "true" : "false"}
                    type="button"
                    disabled={pictureInPictureDisabled}
                  />
                }
              >
                <PictureInPicture2 className={cn(pictureInPicture && "text-primary")} />
              </TooltipTrigger>
              <TooltipPopup>
                {pictureInPicture ? gt("Close floating preview") : gt("Float preview over chat")}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {trailingActions}
        </ToolbarGroup>
      </form>
      <div
        aria-hidden
        data-loading={loading}
        className="preview-loading-progress pointer-events-none absolute bottom-0 left-0 z-10 h-0.5 w-full origin-left rounded-r-full bg-primary"
        style={{ boxShadow: "0 0 6px 1px var(--color-ring)" }}
      />
    </div>
  );
}
