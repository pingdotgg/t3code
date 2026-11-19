import { useAtomValue } from "@effect/atom-react";

import { engineBridge } from "../connection/bridge";
import { engineStatusAtom } from "../state/engine";

export function EngineStatus() {
  const status = useAtomValue(engineStatusAtom);

  if (status.tone === "ask") {
    return (
      <div className="flex flex-col gap-2">
        <span>{status.question}</span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => engineBridge.answerPrompt(true)}
            className="rounded-md bg-fg px-2 py-0.5 font-medium text-bg"
          >
            {status.accept}
          </button>
          <button
            type="button"
            onClick={() => engineBridge.answerPrompt(false)}
            className="rounded-md border border-line px-2 py-0.5 text-fg hover:bg-hover"
          >
            Not now
          </button>
        </div>
      </div>
    );
  }
  const dot = { ok: "bg-emerald-400", busy: "bg-amber-400", off: "bg-offline" }[status.tone];
  return (
    <div className="flex min-w-0 flex-col">
      <span className="flex items-center gap-2">
        <span className={`size-[7px] shrink-0 rounded-full ${dot}`} />
        {status.text}
      </span>
      {status.detail && <span className="pl-[15px] break-words text-faint">{status.detail}</span>}
    </div>
  );
}
