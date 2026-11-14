import { useAtomValue } from "@effect/atom-react";
import { machineDiskSpaceWarnings } from "@t3tools/client-runtime/machine-resources";
import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { HardDriveIcon } from "lucide-react";

import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { Alert, AlertDescription } from "../ui/alert";

/** The server pushes `diskSpace` only when a level changes, so this never polls. */
export function SidebarDiskSpaceWarning() {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const low = [...presentations].flatMap(([environmentId, presentation]) => {
    if (presentation.connection.phase !== "connected") return [];
    const warnings = machineDiskSpaceWarnings(
      presentation.entry.target.label,
      presentation.serverConfig?.diskSpace,
    );
    return warnings.length === 0 ? [] : [{ environmentId, warnings }];
  });
  if (low.length === 0) return null;
  return low.map(({ environmentId, warnings }) => (
    <EnvironmentDiskSpaceWarning
      key={environmentId}
      environmentId={environmentId}
      warnings={warnings}
    />
  ));
}

function EnvironmentDiskSpaceWarning({
  environmentId,
  warnings,
}: {
  readonly environmentId: EnvironmentId;
  readonly warnings: ReturnType<typeof machineDiskSpaceWarnings>;
}) {
  const canReclaim = useAtomValue(
    serverEnvironment.reclaimDatabaseSpace.permissionAtom(environmentId),
  );
  const critical = warnings.some((warning) => warning.tone === "danger");
  return (
    <Alert variant={critical ? "error" : "warning"}>
      <HardDriveIcon />
      <AlertDescription>
        {warnings.map((warning) => (
          <span key={warning.text} className="block">
            {warning.text}
          </span>
        ))}
        <span className="flex gap-2">
          <Link
            to="/settings/diagnostics"
            search={{ machine: environmentId }}
            className="underline underline-offset-2"
          >
            Diagnostics
          </Link>
          {/* Storage offers to reclaim database space when there is enough to be worth it. */}
          {canReclaim ? (
            <Link
              to="/settings/storage"
              search={{ machine: environmentId }}
              className="underline underline-offset-2"
            >
              Storage
            </Link>
          ) : null}
        </span>
      </AlertDescription>
    </Alert>
  );
}
