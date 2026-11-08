import type { LinearTeamContext } from "@t3tools/contracts";
import { useState } from "react";
import { ScrollArea } from "../ui/scroll-area";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { LinearMessage } from "./LinearControls";
import type { LinearSearch } from "./linearSearch";
import type { LinearMutate } from "./linearTypes";
export function LinearCycles({
  context,
  teamId,
  change,
  mutate,
  canWrite,
}: {
  context: typeof LinearTeamContext.Type | null;
  teamId: string | undefined;
  change: (patch: Partial<LinearSearch>) => void;
  mutate: LinearMutate;
  canWrite: boolean;
}) {
  const [editor, setEditor] = useState<{ id?: string } | null>(null);
  const [name, setName] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  if (!teamId) return <LinearMessage>Select a team to see its cycles.</LinearMessage>;
  return (
    <ScrollArea scrollbarGutter>
      <div className="flex flex-col gap-4 p-5">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">Plan and work through your team's cycles.</p>
          <Button
            size="sm"
            variant="outline"
            disabled={!canWrite}
            onClick={() => {
              setEditor({});
              setName("");
              setStart("");
              setEnd("");
            }}
          >
            New cycle
          </Button>
        </div>
        {editor && (
          <form
            className="flex flex-wrap items-end gap-3 rounded-lg border p-4"
            onSubmit={(event) => {
              event.preventDefault();
              const input = {
                name,
                startsAt: new Date(`${start}T00:00:00Z`).toISOString(),
                endsAt: new Date(`${end}T00:00:00Z`).toISOString(),
              };
              void mutate(
                editor.id
                  ? { kind: "cycleUpdate", id: editor.id, input }
                  : { kind: "cycleCreate", input: { ...input, teamId } },
              ).then((result) => {
                if (result) setEditor(null);
              });
            }}
          >
            <label className="flex flex-1 flex-col gap-1 text-xs">
              Cycle name
              <Input value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              Starts
              <Input
                type="date"
                required
                value={start}
                onChange={(event) => setStart(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              Ends
              <Input
                type="date"
                required
                min={start}
                value={end}
                onChange={(event) => setEnd(event.target.value)}
              />
            </label>
            <Button size="sm" type="submit" disabled={!canWrite || !start || !end || end <= start}>
              Save cycle
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditor(null)}>
              Cancel
            </Button>
          </form>
        )}
        {context?.cycles.map((cycle) => (
          <div key={cycle.id} className="flex items-center gap-3 rounded-lg border p-4">
            <button
              type="button"
              className="flex flex-1 items-center justify-between gap-4 text-left"
              onClick={() => change({ view: "all", cycle: cycle.id })}
            >
              <span>
                <strong className="block text-sm">{cycle.name ?? `Cycle ${cycle.number}`}</strong>
                <span className="text-xs text-muted-foreground">
                  Cycle {cycle.number} · {cycle.startsAt.slice(0, 10)} – {cycle.endsAt.slice(0, 10)}
                </span>
              </span>
              <span className="text-xs text-muted-foreground">Open issues →</span>
            </button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!canWrite}
              onClick={() => {
                setEditor({ id: cycle.id });
                setName(cycle.name ?? "");
                setStart(cycle.startsAt.slice(0, 10));
                setEnd(cycle.endsAt.slice(0, 10));
              }}
            >
              Edit cycle
            </Button>
          </div>
        ))}
        {context?.cycles.length === 0 && <LinearMessage>No cycles yet.</LinearMessage>}
      </div>
    </ScrollArea>
  );
}
