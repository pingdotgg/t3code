import { RegistryContext } from "@effect/atom-react";
import {
  createPreviewFramePainter,
  createPreviewStreamClient,
  previewStreamControlLabel,
  type PreviewStreamControl,
  previewStreamHostSetupMessage,
} from "@t3tools/client-runtime/preview/server-browser-stream";
import type { EnvironmentId, PreviewStreamHostSetup } from "@t3tools/contracts";
import { useCallback, useContext, useState } from "react";

import { Notice } from "../artifacts/Notice";
import type { AgentTabRef } from "./browserTabs";
import { previewStreamAccessAtom, usePreviewStreamAccess } from "./previewStream";

/** A refused ticket is minted again. Past this many refusals without a frame, the stream is not coming. */
const MAX_REFUSALS = 3;

/** A watch-only live view of one agent tab, drawn from the engine's preview stream. */
export function AgentStream({
  environmentId,
  target,
}: {
  environmentId: EnvironmentId;
  target: AgentTabRef;
}) {
  const registry = useContext(RegistryContext);
  const access = usePreviewStreamAccess(environmentId);
  const [painted, setPainted] = useState(false);
  const [control, setControl] = useState<PreviewStreamControl | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [setup, setSetup] = useState<PreviewStreamHostSetup | null>(null);
  const { threadId, tabId } = target;
  // A new ticket gives a new `access`, which starts a new stream.
  const connect = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      const box = canvas?.parentElement;
      if (canvas === null || !box || access === null) return;
      const size = box.getBoundingClientRect();
      const ratio = window.devicePixelRatio;
      let refusals = 0;
      const painter = createPreviewFramePainter(canvas, () => {
        refusals = 0;
        setPainted(true);
      });
      const client = createPreviewStreamClient(
        {
          access,
          threadId,
          tabId,
          maxWidth: size.width * ratio,
          maxHeight: size.height * ratio,
          interactive: false,
        },
        {
          onFrame: painter.paint,
          onViewport: () => undefined,
          onConnectedChange: () => undefined,
          onControl: setControl,
          onUnauthorized: () => {
            refusals += 1;
            if (refusals >= MAX_REFUSALS) setProblem("The engine refused the stream.");
            else registry.refresh(previewStreamAccessAtom(environmentId));
          },
          onGone: () => setProblem("This tab closed."),
          onHostSetup: setSetup,
        },
      );
      return () => {
        client.stop();
        painter.stop();
      };
    },
    [access, threadId, tabId, environmentId, registry],
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid min-h-0 flex-1 place-items-center bg-bg">
        <canvas
          ref={connect}
          data-testid="agent-stream"
          data-painted={painted}
          aria-label="Agent tab"
          className={`max-h-full max-w-full object-contain ${painted ? "" : "hidden"}`}
        />
        {!painted && problem === null && setup === null && <Notice>Connecting to the tab</Notice>}
        {problem !== null && <Notice tone="text-red-300">{problem}</Notice>}
        {setup !== null && (
          <div className="px-4 py-3 text-[12px] text-muted">
            <p>{previewStreamHostSetupMessage(setup)}</p>
            <code className="mt-1 block rounded bg-hover px-1.5 py-1 font-mono text-fg">
              {setup.command}
            </code>
          </div>
        )}
      </div>
      <p className="border-t border-line px-3 py-1 text-[11px] text-muted">
        {previewStreamControlLabel(control)}
      </p>
    </div>
  );
}
