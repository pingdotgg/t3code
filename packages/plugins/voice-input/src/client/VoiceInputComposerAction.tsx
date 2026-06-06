import type { PluginComposerActionContext, PluginUiReact } from "@t3tools/plugin-api/ui";

import { formatElapsed, useVoiceRecorder } from "./useVoiceRecorder.ts";

function renderMicrophoneIcon(React: PluginUiReact) {
  return React.createElement(
    "svg",
    {
      width: "14",
      height: "14",
      viewBox: "0 0 14 14",
      fill: "none",
      "aria-hidden": "true",
    },
    React.createElement("path", {
      d: "M7 1.75C5.9 1.75 5 2.65 5 3.75V7C5 8.1 5.9 9 7 9C8.1 9 9 8.1 9 7V3.75C9 2.65 8.1 1.75 7 1.75Z",
      stroke: "currentColor",
      strokeWidth: "1.4",
    }),
    React.createElement("path", {
      d: "M3.5 6.5C3.5 8.43 5.07 10 7 10C8.93 10 10.5 8.43 10.5 6.5M7 10V12.25M5.25 12.25H8.75",
      stroke: "currentColor",
      strokeWidth: "1.4",
      strokeLinecap: "round",
    }),
  );
}

export function VoiceInputComposerAction({ ctx }: { readonly ctx: PluginComposerActionContext }) {
  const React = ctx.react;
  const C = ctx.components;
  const recorder = useVoiceRecorder(ctx);

  if (!recorder.enabled) {
    return null;
  }

  const disabled =
    recorder.mode === "loading" ||
    recorder.mode === "transcribing" ||
    recorder.mode === "dependencyMissing" ||
    recorder.mode === "unsupported";
  const active = recorder.mode === "recording";

  return (
    <C.Button
      variant={active ? "outline" : "ghost"}
      size="xs"
      disabled={disabled}
      title={recorder.tooltip}
      onClick={recorder.toggle}
      style={{
        minWidth: active ? 56 : 32,
        height: 30,
        paddingLeft: active ? 10 : 8,
        paddingRight: active ? 10 : 8,
        color: active ? "var(--destructive)" : undefined,
      }}
    >
      {recorder.mode === "transcribing" ? (
        <C.Spinner label="Transcribing" />
      ) : (
        renderMicrophoneIcon(React)
      )}
      {active ? <span>{formatElapsed(recorder.elapsedSeconds)}</span> : null}
    </C.Button>
  );
}
