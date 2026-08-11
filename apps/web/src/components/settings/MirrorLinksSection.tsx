import type { EnvironmentId, MirrorLinkInfo } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { FolderSyncIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { mirrorEnvironment } from "../../state/mirror";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/**
 * "Shared folders" — every mirror link this device's environments hold as an
 * origin (folders shared to a host). Lets the user spot and remove leftovers
 * from hosts where the project no longer exists.
 */
export function MirrorLinksSection({
  environments,
}: {
  environments: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly label: string }>;
}) {
  if (environments.length === 0) return null;
  return (
    <SettingsSection title="Shared folders">
      <p className="px-3 pb-1 text-[13px] leading-[1.45] text-muted-foreground/80 sm:px-4">
        Folders on your machines that project mirroring shares to a host. Remove a link here if the
        mirrored project was deleted on the host and the entry is left over.
      </p>
      {environments.map((environment) => (
        <EnvironmentMirrorLinks
          key={environment.environmentId}
          environmentId={environment.environmentId}
          environmentLabel={environment.label}
        />
      ))}
    </SettingsSection>
  );
}

function EnvironmentMirrorLinks({
  environmentId,
  environmentLabel,
}: {
  environmentId: EnvironmentId;
  environmentLabel: string;
}) {
  const linksQuery = useEnvironmentQuery(mirrorEnvironment.listLinks({ environmentId, input: {} }));
  const detach = useAtomCommand(mirrorEnvironment.detach, { reportFailure: false });
  const [removingProjectId, setRemovingProjectId] = useState<string | null>(null);

  const handleRemove = useCallback(
    async (link: MirrorLinkInfo) => {
      setRemovingProjectId(link.projectId);
      try {
        const result = await detach({ environmentId, input: { projectId: link.projectId } });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add({
              type: "error",
              title: "Failed to remove mirror link",
              description: error instanceof Error ? error.message : "An error occurred.",
            });
          }
          return;
        }
        toastManager.add({
          type: "success",
          title: "Mirror link removed",
          description: link.localRootPath,
        });
      } finally {
        setRemovingProjectId(null);
        linksQuery.refresh();
      }
    },
    [detach, environmentId, linksQuery],
  );

  const links = linksQuery.data?.links ?? [];
  if (links.length === 0) return null;
  return (
    <>
      {links.map((link) => (
        <SettingsRow
          key={`${environmentId}:${link.projectId}`}
          title={
            <span className="flex min-w-0 items-center gap-1.5">
              <FolderSyncIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate font-mono text-sm">{link.localRootPath}</span>
            </span>
          }
          description={`On ${environmentLabel}, mirrored to ${link.hostUrl}`}
          control={
            <Button
              variant="destructive-outline"
              size="xs"
              disabled={removingProjectId === link.projectId}
              onClick={() => void handleRemove(link)}
            >
              {removingProjectId === link.projectId ? "Removing…" : "Remove"}
            </Button>
          }
        />
      ))}
    </>
  );
}
