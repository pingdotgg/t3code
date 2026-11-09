import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { computerUseActionLabel } from "@t3tools/shared/toolActivity";
import { MonitorIcon } from "lucide-react";

import { ChatMarkdownAssetImage } from "./ChatMarkdownMedia";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

type ToolOutputImage = Extract<AssetResource, { readonly _tag: "tool-output-image" }>;

/**
 * The expanded body for a screen-control tool call. Shows the capture the tool returned with the
 * action it performed, instead of a generic image and the raw argument JSON.
 *
 * Colours come only from theme tokens, so the card follows every light, dark, and custom theme.
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
  return (
    <div className="overflow-hidden rounded-xl border border-border/70 bg-muted/20">
      <div className="flex min-w-0 items-center gap-2 border-b border-border/60 bg-gradient-to-b from-foreground/[0.04] to-transparent px-2.5 py-2">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <MonitorIcon className="size-3.5" aria-hidden="true" />
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-2xs font-medium text-foreground">Computer use</span>
          {action ? (
            <span className="truncate text-2xs text-muted-foreground">{action}</span>
          ) : null}
        </div>
        {props.running ? (
          <span className="ms-auto flex shrink-0 items-center gap-1.5 rounded-full bg-primary/10 px-2 py-0.5 text-2xs font-medium text-primary">
            <span className="size-1.5 animate-pulse rounded-full bg-primary" aria-hidden="true" />
            Controlling
          </span>
        ) : null}
      </div>
      <div className="bg-gradient-to-b from-background/30 to-background/60 p-2">
        {props.images.length > 0 ? (
          <div className="space-y-2">
            {props.images.map((resource) => (
              <div
                key={resource.index}
                className="overflow-hidden rounded-lg border border-border/60 bg-background shadow-sm ring-1 ring-border/40"
              >
                <ChatMarkdownAssetImage
                  environmentId={props.environmentId}
                  resource={resource}
                  alt={action ? `Screen after ${action.toLowerCase()}` : "Computer screen"}
                  framed={false}
                  style={{ width: "100%", maxWidth: "100%", height: "auto" }}
                  onImageExpand={props.onImageExpand}
                />
              </div>
            ))}
            {props.output ? <ComputerUseOutput text={props.output} /> : null}
          </div>
        ) : props.output ? (
          <div className="space-y-2">
            <ComputerUseOutput text={props.output} />
          </div>
        ) : (
          <p className="px-1 py-4 text-center text-2xs text-muted-foreground">
            {props.pending
              ? "Loading screen…"
              : props.error
                ? `Couldn't load the screen: ${props.error}`
                : "No screenshot for this step."}
          </p>
        )}
      </div>
    </div>
  );
}

/** The tool's text result, which carries confirmations and failures such as `Permission denied`. */
function ComputerUseOutput(props: { readonly text: string }) {
  return (
    <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/50 bg-muted/40 px-2 py-1.5 font-mono text-2xs text-muted-foreground">
      {props.text}
    </pre>
  );
}
