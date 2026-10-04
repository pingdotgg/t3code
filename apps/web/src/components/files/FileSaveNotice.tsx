import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { Button } from "../ui/button";
import {
  clearProjectFileQueryData,
  getProjectFileQueryAtom,
  optimisticFileAtom,
} from "./projectFilesQueryState";

export function FileSaveNotice({
  environmentId,
  cwd,
  relativePath,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
}) {
  const pending = useAtomValue(optimisticFileAtom(environmentId, cwd, relativePath));
  const [inspect, setInspect] = useState(false);
  const disk = useAtomValue(getProjectFileQueryAtom(environmentId, cwd, relativePath));
  if (!pending?.saveError) return null;
  return (
    <div
      role="alert"
      className="shrink-0 border-b border-warning/30 bg-warning-surface p-3 text-sm"
    >
      <p>{pending.saveError}</p>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            appAtomRegistry.refresh(getProjectFileQueryAtom(environmentId, cwd, relativePath));
            setInspect((v) => !v);
          }}
        >
          Compare versions
        </Button>
      </div>
      {inspect ? (
        <div className="grid gap-2 py-2">
          <label>
            Your unsaved edits (copy before discarding)
            <textarea
              className="block h-32 w-full rounded border bg-background p-2 font-mono text-xs"
              readOnly
              value={pending.data.contents}
            />
          </label>
          <label>
            Current disk version
            <textarea
              className="block h-32 w-full rounded border bg-background p-2 font-mono text-xs"
              readOnly
              value={disk._tag === "Success" ? disk.value.contents : "Loading disk version…"}
            />
          </label>
          <Button
            variant="outline"
            disabled={disk._tag !== "Success"}
            onClick={() => {
              clearProjectFileQueryData(environmentId, cwd, relativePath);
              setInspect(false);
            }}
          >
            Discard my unsaved edits and use disk version
          </Button>
        </div>
      ) : null}
    </div>
  );
}
