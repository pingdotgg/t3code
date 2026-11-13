import {
  createPreviewFramePainter,
  createPreviewStreamClient,
  previewStreamControlLabel,
  previewStreamModifiers,
  type PreviewStreamClient,
  type PreviewStreamControl,
  type PreviewStreamDownload,
  type PreviewStreamFileChooser,
  uploadPreviewStreamFiles,
  type PreviewStreamInput,
  type PreviewStreamMouseButton,
  type PreviewStreamPointer,
  type PreviewStreamViewport,
  previewStreamHostSetupMessage,
} from "@t3tools/client-runtime/preview/server-browser-stream";
import type {
  EnvironmentId,
  PreviewStreamHostSetup,
  PreviewViewportSetting,
} from "@t3tools/contracts";
import { Dispatch, RefObject, SetStateAction, type ClipboardEvent, type FormEvent, type KeyboardEvent, type MouseEvent, type PointerEvent, type Ref, useEffect, useEffectEvent, useImperativeHandle, useRef, useState } from "react";
import { AgentCursorMark } from "~/components/preview/AgentBrowserCursor";
import { CommandBlock } from "~/components/CommandBlock";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { toastManager } from "~/components/ui/toast";
import { cn } from "~/lib/utils";
import { refreshPreviewStreamAccess, usePreviewStreamAccess } from "~/state/previewStream";
import { observeResize } from "~/lib/observeResize";
import { COPY, CUT } from "./ServerBrowserSurface";
import type { AgentCursorPlacement } from "./ServerBrowserSurface";
import type { CxOptions } from "class-variance-authority";
import type { Brand } from "effect/Brand";

export interface ServerBrowserViewportProps {
  readonly accessDenied: boolean;
  readonly agentCursor: AgentCursorPlacement | null;
  readonly answerFileChooser: (files: ReadonlyArray<File>) => void;
  readonly canvasRef: RefObject<HTMLCanvasElement | null>;
  readonly className: string | undefined;
  readonly cn: (...inputs: CxOptions) => string;
  readonly control: PreviewStreamControl | null;
  readonly controlPosition: "bottom" | "top";
  readonly COPY: { readonly key: "c"; readonly code: "KeyC"; readonly keyCode: 67; };
  readonly CUT: { readonly key: "x"; readonly code: "KeyX"; readonly keyCode: 88; };
  readonly environmentId: string & Brand<"EnvironmentId">;
  readonly fileChooser: PreviewStreamFileChooser | null;
  readonly fileInputRef: RefObject<HTMLInputElement | null>;
  readonly handleClipboard: (key: typeof COPY | typeof CUT, event: ClipboardEvent) => void;
  readonly handleInput: (event: FormEvent<HTMLTextAreaElement>) => void;
  readonly handleKey: (action: "down" | "up", event: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly handleMouseUp: (event: MouseEvent<HTMLDivElement>) => void;
  readonly handlePointer: (event: PointerEvent<HTMLCanvasElement>) => void;
  readonly hostSetup: { readonly need: "sandbox" | "libraries"; readonly command: string; } | null;
  readonly INPUT_SENTINEL: "​";
  readonly inputRef: RefObject<HTMLTextAreaElement | null>;
  readonly pdfUrl: string | null;
  readonly previewStreamControlLabel: (control: PreviewStreamControl | null) => string;
  readonly previewStreamHostSetupMessage: (setup: PreviewStreamHostSetup) => "This server's host blocks the sandbox its browser runs in. Run this once on the host, then try again:" | "This server's host is missing libraries its browser needs. Run this once on the host, then try again:";
  readonly promptText: string;
  readonly refreshPreviewStreamAccess: (environmentId: EnvironmentId) => void;
  readonly resetInput: (textarea: HTMLTextAreaElement) => void;
  readonly send: (input: PreviewStreamInput) => void;
  readonly setAccessDenied: Dispatch<SetStateAction<boolean>>;
  readonly setHostSetup: Dispatch<SetStateAction<{ readonly need: "sandbox" | "libraries"; readonly command: string; } | null>>;
  readonly setPromptText: Dispatch<SetStateAction<string>>;
  readonly tabId: string;
  readonly unauthorizedRef: RefObject<number>;
  readonly visible: boolean;
}

export function ServerBrowserViewport(props: ServerBrowserViewportProps) {
  const {
    accessDenied,
    agentCursor,
    answerFileChooser,
    canvasRef,
    className,
    cn,
    control,
    controlPosition,
    COPY,
    CUT,
    environmentId,
    fileChooser,
    fileInputRef,
    handleClipboard,
    handleInput,
    handleKey,
    handleMouseUp,
    handlePointer,
    hostSetup,
    INPUT_SENTINEL,
    inputRef,
    pdfUrl,
    previewStreamControlLabel,
    previewStreamHostSetupMessage,
    promptText,
    refreshPreviewStreamAccess,
    resetInput,
    send,
    setAccessDenied,
    setHostSetup,
    setPromptText,
    tabId,
    unauthorizedRef,
    visible,
  } = props;
  return (
    <div
      className={cn("relative flex flex-col overflow-hidden", className)}
      data-server-browser-surface={tabId}
      onMouseUp={handleMouseUp}
    >
      <div
        className={cn(
          "visible relative z-20 flex shrink-0 items-center justify-between gap-2 border-border bg-background px-2 py-1",
          controlPosition === "bottom" ? "order-last border-t" : "border-b",
        )}
      >
        <span role="status" className="text-xs text-muted-foreground">
          {previewStreamControlLabel(control)}
        </span>
        {control?.canOperate ? (
          <Button
            variant="outline"
            size="xs"
            disabled={control.controller === "another-viewer"}
            onClick={() =>
              send({ type: control.controller === "you" ? "releaseControl" : "takeControl" })
            }
          >
            {control.controller === "you" ? "Release control" : "Take control"}
          </Button>
        ) : null}
      </div>
      <div className="relative min-h-0 flex-1">
        {pdfUrl ? (
          <embed
            src={pdfUrl}
            type="application/pdf"
            title="PDF document"
            className="absolute inset-0 z-10 size-full border-0"
          />
        ) : null}
        <canvas
          ref={canvasRef}
          className="block size-full touch-none object-contain"
          onPointerDown={handlePointer}
          onPointerMove={handlePointer}
          onPointerUp={handlePointer}
          onPointerCancel={handlePointer}
          onMouseDown={(event) => event.preventDefault()}
          onContextMenu={(event) => event.preventDefault()}
        />
        {!pdfUrl && agentCursor && control?.controller !== "you" ? (
          <AgentCursorMark
            {...agentCursor}
            controller={control?.controller === "agent" ? "agent" : "none"}
          />
        ) : null}
        {/* Pin top-left to avoid focus scrolling; 16px prevents iOS focus zoom. */}
        <textarea
          ref={inputRef}
          aria-label="Browser page"
          aria-description="Press Shift+Escape to leave the browser page."
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          disabled={pdfUrl !== null || control?.controller !== "you"}
          defaultValue={INPUT_SENTINEL}
          onFocus={(event) => resetInput(event.currentTarget)}
          className="sr-only top-0 left-0 text-base"
          onKeyDown={(event) => handleKey("down", event)}
          onKeyUp={(event) => handleKey("up", event)}
          onInput={handleInput}
          onCompositionEnd={(event) => {
            const text = event.data.replace(/^\u200b/, "");
            if (text) send({ type: "text", text });
            resetInput(event.currentTarget);
          }}
          onCopy={(event) => handleClipboard(COPY, event)}
          onCut={(event) => handleClipboard(CUT, event)}
          onPaste={(event) => {
            event.preventDefault();
            const text = event.clipboardData.getData("text/plain");
            if (text) send({ type: "text", text });
          }}
        />
        {fileChooser && control?.controller === "you" ? (
          <div
            className="absolute inset-x-2 top-2 z-10 flex flex-col gap-2 rounded-lg border border-border bg-background p-3 shadow-lg"
            role="dialog"
            aria-label="Choose files for the page"
          >
            <p className="text-sm">
              The page asks for {fileChooser.multiple ? "files" : "a file"}.
            </p>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              multiple={fileChooser.multiple}
              accept={fileChooser.accept}
              onChange={(event) => {
                const files = [...(event.currentTarget.files ?? [])];
                event.currentTarget.value = "";
                if (files.length > 0) answerFileChooser(files);
              }}
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => answerFileChooser([])}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => fileInputRef.current?.click()}>
                Choose {fileChooser.multiple ? "files" : "file"}
              </Button>
            </div>
          </div>
        ) : null}
        {control?.dialog ? (
          <div
            className="absolute inset-x-2 top-2 z-10 flex flex-col gap-2 rounded-lg border border-border bg-background p-3 shadow-lg"
            role="dialog"
            aria-label="Browser dialog"
          >
            <p className="break-words text-sm">{control.dialog.message}</p>
            {control.controller === "you" ? (
              <>
                {control.dialog.type === "prompt" ? (
                  <Input
                    aria-label="Dialog response"
                    value={promptText}
                    onChange={(event) => setPromptText(event.target.value)}
                  />
                ) : null}
                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => send({ type: "dialog", accept: false })}
                  >
                    Dismiss
                  </Button>
                  <Button
                    size="sm"
                    onClick={() =>
                      send({
                        type: "dialog",
                        accept: true,
                        ...(control.dialog?.type === "prompt" ? { promptText } : {}),
                      })
                    }
                  >
                    Accept
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">Take control to respond.</p>
            )}
          </div>
        ) : null}
      </div>
      {visible && hostSetup ? (
        <div className="visible absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-background p-4 text-center">
          <p role="alert" className="max-w-sm text-sm text-muted-foreground">
            {previewStreamHostSetupMessage(hostSetup)}
          </p>
          <CommandBlock command={hostSetup.command} className="w-full max-w-md text-left" />
          <Button variant="outline" size="sm" onClick={() => setHostSetup(null)}>
            Try again
          </Button>
        </div>
      ) : null}
      {visible && accessDenied ? (
        // The page can be invisible beneath an empty or unreachable state; reconnect must remain reachable.
        <div className="visible absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-background p-3 text-center">
          <p role="alert" className="text-xs text-muted-foreground">
            Browser connection was refused.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              unauthorizedRef.current = 0;
              setAccessDenied(false);
              refreshPreviewStreamAccess(environmentId);
            }}
          >
            Reconnect
          </Button>
        </div>
      ) : null}
    </div>
  );
}
