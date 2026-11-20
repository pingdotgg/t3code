import type { UpdatePrefs } from "../../state/updatesAtoms";
import type { UpdateRow, VersionStatus } from "../../state/updates";
import { buttonClass } from "../controls/buttonClass";
import { SettingsRow } from "../SettingsRow";
import { CopyCommand } from "./CopyCommand";

const NOTE_TONE = { progress: "text-muted", problem: "text-amber-400" } as const;

const STATUS_TEXT = {
  current: "Up to date",
  behind: "Update available",
  unknown: "Version not checked",
} as const satisfies Record<VersionStatus, string>;

function versionsText(row: UpdateRow): string {
  if (row.missing) return "Not installed on the machine that runs T3";
  const have = `Installed ${row.installed ?? "unknown"}`;
  return row.latest === null ? have : `${have} · Latest ${row.latest}`;
}

export function UpdateItemRow({
  row,
  prefs,
  busy,
  onUpdate,
}: {
  row: UpdateRow;
  prefs: UpdatePrefs | null;
  busy: boolean;
  onUpdate: () => void;
}) {
  const offer = row.offer;
  const automatic = prefs?.automatic[row.key];
  const waiting = row.action === "wait";
  const updating = row.running || busy;
  return (
    <SettingsRow
      title={row.name}
      description={versionsText(row)}
      control={
        <div className="flex items-center gap-3">
          {updating ? (
            <span className="text-xs text-muted">Updating…</span>
          ) : (
            <span className={`text-xs ${row.status === "behind" ? "text-sky-400" : "text-faint"}`}>
              {row.missing ? "Not installed" : STATUS_TEXT[row.status]}
            </span>
          )}
          {!updating && offer?.canUpdate === true && (
            <button type="button" onClick={onUpdate} className={buttonClass}>
              {row.kind === "engine" ? "Update now" : "Update"}
            </button>
          )}
        </div>
      }
    >
      {waiting && (
        <p className="text-xs text-muted">
          Waiting for {row.activeRuns} running {row.activeRuns === 1 ? "turn" : "turns"} to finish.
        </p>
      )}
      {row.note !== null && (
        <p aria-live="polite" className={`text-xs break-words ${NOTE_TONE[row.note.tone]}`}>
          {row.note.text}
        </p>
      )}
      {automatic !== undefined && (
        <p className="text-xs text-faint">
          Updated automatically to {automatic.version} on {new Date(automatic.at).toLocaleString()}.
        </p>
      )}
      {row.kind === "engine" && row.status === "behind" && offer === null && (
        <p className="text-xs text-faint">
          The app cannot update this engine. Update it where it runs.
        </p>
      )}
      {offer !== null && !offer.canUpdate && row.command !== null && (
        <>
          <p className="text-xs text-faint">T3 cannot run this update. Run it in a terminal:</p>
          <CopyCommand command={row.command} />
        </>
      )}
    </SettingsRow>
  );
}
