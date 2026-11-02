import { RefreshIcon } from "~/components/ui/refresh-icon";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  ExternalLink,
  MousePointerClick,
  PictureInPicture2,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useState,
} from "react";

import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useT } from "~/hooks/useI18n";
import { cn } from "~/lib/utils";

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
  onSubmit: (url: string) => void;
  onOpenInBrowser?: (() => void) | undefined;
  onCapture?: ((record: boolean) => void) | undefined;
  captureDisabled?: boolean | undefined;
  recording?: boolean | undefined;
  onPictureInPicture?: (() => void) | undefined;
  pictureInPicture?: boolean | undefined;
  pictureInPictureDisabled?: boolean | undefined;
  onPickElement?: (() => void) | undefined;
  pickActive?: boolean | undefined;
  pickDisabled?: boolean | undefined;
  pickDisabledReason?: string | undefined;
  trailingActions?: ReactNode;
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
}: Props) {
  const t = useT();
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
        className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent"
        data-surface-subheader
      >
        <div
          className="flex items-center gap-0.5"
          role="group"
          aria-label={t("review.preview.chrome.navigation")}
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={canGoBack ? onBack : NOOP}
                  disabled={!canGoBack}
                  aria-label={t("review.preview.chrome.back")}
                  type="button"
                />
              }
            >
              <ArrowLeft />
            </TooltipTrigger>
            <TooltipPopup>{t("review.preview.chrome.back")}</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={canGoForward ? onForward : NOOP}
                  disabled={!canGoForward}
                  aria-label={t("review.preview.chrome.forward")}
                  type="button"
                />
              }
            >
              <ArrowRight />
            </TooltipTrigger>
            <TooltipPopup>{t("review.preview.chrome.forward")}</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={refreshDisabled ? NOOP : onRefresh}
                  disabled={refreshDisabled}
                  aria-label={
                    loading ? t("review.preview.chrome.stop") : t("review.preview.chrome.refresh")
                  }
                  type="button"
                />
              }
            >
              <RefreshIcon refreshing={loading} />
            </TooltipTrigger>
            <TooltipPopup>
              {loading ? t("review.preview.chrome.loading") : t("review.preview.chrome.refresh")}
            </TooltipPopup>
          </Tooltip>
        </div>

        {leadingActions}

        <InputGroup variant="ghost" className="group/address h-7 flex-1">
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
                    if (event.key === "Enter") submit(event);
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setDraft(url);
                      inputRef.current?.blur();
                    }
                  }}
                  placeholder={t("review.preview.chrome.urlPlaceholder")}
                  aria-label={t("review.preview.chrome.urlPlaceholder")}
                  data-workspace-focus-default
                  spellCheck={false}
                  disabled={inputDisabled}
                  data-preview-url-input
                  size="sm"
                />
              }
            />
          </Tooltip>
          {onOpenInBrowser && !inputFocused ? (
            <InputGroupAddon align="inline-end">
              {}
              <span className="pointer-events-none flex opacity-0 transition-opacity focus-within:pointer-events-auto focus-within:opacity-100 group-hover/address:pointer-events-auto group-hover/address:opacity-100">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={onOpenInBrowser}
                        aria-label={t("review.preview.chrome.openSystemBrowser")}
                        type="button"
                      />
                    }
                  >
                    <ExternalLink />
                  </TooltipTrigger>
                  <TooltipPopup>{t("review.preview.chrome.openSystemBrowser")}</TooltipPopup>
                </Tooltip>
              </span>
            </InputGroupAddon>
          ) : null}
        </InputGroup>

        {onPickElement ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant={pickActive ? "secondary" : "ghost"}
                  size="icon-xs"
                  onClick={onPickElement}
                  disabled={pickDisabled}
                  aria-label={
                    pickActive
                      ? t("review.preview.chrome.cancelAnnotation")
                      : t("review.preview.chrome.annotatePreview")
                  }
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
                  ? t("review.preview.chrome.cancelAnnotationEsc")
                  : t("review.preview.chrome.annotateHint")}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {onCapture ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant={recording ? "secondary" : "ghost"}
                  size="icon-xs"
                  onClick={(event) => onCapture(event.shiftKey)}
                  aria-label={
                    recording
                      ? t("review.preview.chrome.stopRecording")
                      : t("review.preview.chrome.captureScreenshot")
                  }
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
              {recording
                ? t("review.preview.chrome.stopRecording")
                : t("review.preview.chrome.screenshotHint")}
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
                      ? t("review.preview.chrome.closeFloating")
                      : t("review.preview.chrome.floatPreview")
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
              {pictureInPicture
                ? t("review.preview.chrome.closeFloating")
                : t("review.preview.chrome.floatPreview")}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {trailingActions}
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
