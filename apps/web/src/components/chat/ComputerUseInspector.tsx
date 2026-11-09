import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { computerUseActionLabel } from "@t3tools/shared/toolActivity";
import { LoaderCircleIcon, MonitorIcon } from "lucide-react";

import { ChatMarkdownAssetImage } from "./ChatMarkdownMedia";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

type ToolOutputImage = Extract<AssetResource, { readonly _tag: "tool-output-image" }>;

/**
 * The expanded body for a screen-control tool call. Shows the capture the tool returned with the
 * action it performed, instead of a generic image and the raw argument JSON.
 *
 * The surface is a flat card with hairline dividers, and every colour comes from a theme token, so
 * it follows each light, dark, and custom appearance.
 */
export function ComputerUseInspector(props: {
  readonly toolName: string | null;
  readonly input: unknown;
  readonly running: boolean;
  /** The tool's text result, which carries confirmations and failures that have no image. */
  readonly output: string | null;
  readonly images: ReadonlyArray<ToolOutputImage>;
  readonly environmentId: EnvironmentId;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}) {
  const action = computerUseActionLabel(props.toolName, props.input);
  const hasImages = props.images.length > 0;
  return (
    <div className="min-w-0 overflow-hidden rounded-xl border border-border/70 bg-card">
      <div className="flex min-w-0 items-start gap-2 px-3 py-2.5">
        <MonitorIcon
          className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-xs font-medium text-foreground">Computer use</span>
            {props.running ? (
              <span className="ms-auto inline-flex shrink-0 items-center gap-1 text-2xs text-muted-foreground">
                <LoaderCircleIcon className="size-3 animate-spin" aria-hidden="true" />
                Working
              </span>
            ) : null}
          </div>
          {action ? (
            <p className="mt-0.5 truncate text-2xs text-muted-foreground">{action}</p>
          ) : null}
        </div>
      </div>
      {hasImages ? (
        <div className="divide-y divide-border/70 border-t border-border/70 bg-muted/30">
          {props.images.map((resource) => (
            <ChatMarkdownAssetImage
              key={resource.index}
              environmentId={props.environmentId}
              resource={resource}
              alt={action ? `Screen after ${action.toLowerCase()}` : "Computer screen"}
              framed={false}
              className="block"
              style={{
                width: "100%",
                height: "auto",
                maxHeight: "24rem",
                objectFit: "contain",
                objectPosition: "top center",
              }}
              onImageExpand={props.onImageExpand}
            />
          ))}
        </div>
      ) : null}
      {props.output ? <ComputerUseOutput text={props.output} /> : null}
      {!hasImages && !props.output ? (
        <p
          className={
            props.error
              ? "border-t border-border/70 px-3 py-3 text-2xs text-destructive"
              : "flex items-center gap-1.5 border-t border-border/70 px-3 py-3 text-2xs text-muted-foreground"
          }
        >
          {props.pending ? (
            <>
              <LoaderCircleIcon className="size-2.5 animate-spin" aria-hidden="true" />
              Loading screen…
            </>
          ) : props.error ? (
            `Couldn't load the screen: ${props.error}`
          ) : (
            "No screenshot for this step."
          )}
        </p>
      ) : null}
    </div>
  );
}

/** The tool's text result, which carries confirmations and failures such as `Permission denied`. */
function ComputerUseOutput(props: { readonly text: string }) {
  return (
    <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words border-t border-border/70 bg-muted/30 px-3 py-2 font-mono text-2xs leading-relaxed text-muted-foreground">
      {props.text}
    </pre>
  );
}
