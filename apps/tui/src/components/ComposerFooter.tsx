import * as React from "react";

import { type ComposerControls, interactionModeLabel, runtimeModeLabel } from "../controls.ts";
import { ansi, usePalette } from "../theme.ts";

// The composer footer (mirrors apps/web ChatComposer): a model picker + mode
// controls on the left, and the primary action on the right. Component names
// match the web — ProviderModelPicker / ComposerFooterModeControls /
// ComposerFooterPrimaryActions — so the two share a design vocabulary. Lives
// inside the persistent composer box, so it carries no own padding.

function Chip({
  keyHint,
  label,
  active,
  muted,
  dropdown,
  onClick,
}: {
  readonly keyHint: string;
  readonly label: string;
  readonly active?: boolean;
  readonly muted?: boolean;
  readonly dropdown?: boolean;
  readonly onClick: () => void;
}): React.ReactNode {
  const palette = usePalette();
  const labelColor = active ? palette.accent : muted ? palette.dim : palette.text;
  return (
    <box onMouseDown={onClick} flexShrink={0}>
      <text>
        {keyHint ? <span fg={active ? palette.accent : palette.dim}>{`${keyHint} `}</span> : null}
        <span fg={labelColor}>{`${label}${dropdown ? " ▾" : ""}`}</span>
      </text>
    </box>
  );
}

function FooterSeparator(): React.ReactNode {
  const palette = usePalette();
  return <text fg={palette.dim}>{" │ "}</text>;
}

/** The model selector (web ProviderModelPicker), leading the footer. */
function ProviderModelPicker({
  model,
  onOpen,
}: {
  readonly model: string | null;
  readonly onOpen: () => void;
}): React.ReactNode {
  return <Chip keyHint="model" label={model ?? "—"} muted={!model} dropdown onClick={onOpen} />;
}

/** Effort + plan/build mode + runtime access (web ComposerFooterModeControls). */
function ComposerFooterModeControls({
  controls,
  compact,
  onOpenReasoning,
  onTogglePlan,
  onOpenAccess,
}: {
  readonly controls: ComposerControls;
  readonly compact: boolean;
  readonly onOpenReasoning: () => void;
  readonly onTogglePlan: () => void;
  readonly onOpenAccess: () => void;
}): React.ReactNode {
  return (
    <>
      <FooterSeparator />
      <Chip
        keyHint="effort"
        label={controls.reasoning ?? "—"}
        muted={!controls.reasoning}
        dropdown
        onClick={onOpenReasoning}
      />
      <FooterSeparator />
      <Chip
        keyHint={compact ? "" : "^O"}
        label={runtimeModeLabel(controls.runtimeMode)}
        dropdown
        onClick={onOpenAccess}
      />
      <FooterSeparator />
      <Chip
        keyHint={compact ? "" : "^B"}
        label={interactionModeLabel(controls.interactionMode)}
        active={controls.interactionMode === "plan"}
        onClick={onTogglePlan}
      />
    </>
  );
}

/**
 * The right-aligned primary action (web ComposerFooterPrimaryActions): Stop while
 * the agent runs, Submit answer while a question is pending, else Send. Clickable,
 * and also reachable via Esc / Enter.
 */
function ComposerFooterPrimaryActions({
  working,
  answering,
  hasText,
  onStop,
  onSend,
  onSubmitAnswer,
}: {
  readonly working: boolean;
  readonly answering: boolean;
  readonly hasText: boolean;
  readonly onStop: () => void;
  readonly onSend: () => void;
  readonly onSubmitAnswer: () => void;
}): React.ReactNode {
  const palette = usePalette();
  if (working) {
    return (
      <box onMouseDown={onStop} flexShrink={0}>
        <text>
          <span fg={ansi("red")}>■ Stop</span>
          <span fg={palette.dim}> Esc</span>
        </text>
      </box>
    );
  }
  if (answering) {
    return (
      <box onMouseDown={onSubmitAnswer} flexShrink={0}>
        <text>
          <span fg={palette.accent}>▸ Submit answer</span>
          <span fg={palette.dim}> ⏎</span>
        </text>
      </box>
    );
  }
  return (
    <box onMouseDown={onSend} flexShrink={0}>
      <text>
        <span fg={hasText ? palette.accent : palette.dim}>▸ Send</span>
        <span fg={palette.dim}> ⏎</span>
      </text>
    </box>
  );
}

export const ComposerFooter = React.memo(function ComposerFooter({
  controls,
  compact = false,
  working,
  answering,
  hasText,
  onTogglePlan,
  onOpenAccess,
  onOpenModel,
  onOpenReasoning,
  onStop,
  onSend,
  onSubmitAnswer,
}: {
  readonly controls: ComposerControls;
  readonly compact?: boolean;
  readonly working: boolean;
  /** A pending question is awaiting an answer (primary action becomes Submit). */
  readonly answering: boolean;
  /** The reply has text (drives the Send affordance). */
  readonly hasText: boolean;
  readonly onTogglePlan: () => void;
  readonly onOpenAccess: () => void;
  readonly onOpenModel: () => void;
  readonly onOpenReasoning: () => void;
  readonly onStop: () => void;
  readonly onSend: () => void;
  readonly onSubmitAnswer: () => void;
}): React.ReactNode {
  // Order mirrors the web composer footer: model → effort → access → mode on
  // the left, the primary action pushed to the right.
  const controlsRow = (
    <box flexDirection="row" flexShrink={0}>
      <ProviderModelPicker model={controls.model} onOpen={onOpenModel} />
      <ComposerFooterModeControls
        controls={controls}
        compact={compact}
        onOpenReasoning={onOpenReasoning}
        onTogglePlan={onTogglePlan}
        onOpenAccess={onOpenAccess}
      />
    </box>
  );
  const primary = (
    <ComposerFooterPrimaryActions
      working={working}
      answering={answering}
      hasText={hasText}
      onStop={onStop}
      onSend={onSend}
      onSubmitAnswer={onSubmitAnswer}
    />
  );
  if (compact) {
    return (
      <box flexDirection="column" marginTop={1} flexShrink={0}>
        {controlsRow}
        <box flexDirection="row" justifyContent="flex-end">
          {primary}
        </box>
      </box>
    );
  }
  return (
    <box flexDirection="row" marginTop={1} flexShrink={0}>
      {controlsRow}
      <box flexGrow={1} />
      {primary}
    </box>
  );
});
