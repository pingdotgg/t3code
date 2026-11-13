import {
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
} from "@t3tools/client-runtime/state/filesystem";
import { ensureBrowseDirectoryPath } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentId } from "@t3tools/contracts";
import { FolderIcon, ArrowUpIcon } from "lucide-react";
import { filesystemEnvironment, useFilesystemReadAccess } from "../../state/filesystem";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";

export function ExtensionFolderBrowser({
  environmentId,
  platform,
  path,
  onSelect,
}: {
  environmentId: EnvironmentId;
  platform: string;
  path: string;
  onSelect: (path: string) => void;
}) {
  const browse = getFilesystemBrowsePath(path, platform);
  const access = useFilesystemReadAccess(environmentId);
  const query = useEnvironmentQuery(
    access.canReadFiles && browse.isBrowsing
      ? filesystemEnvironment.browse({
          environmentId,
          input: { partialPath: browse.directoryPath },
        })
      : null,
  );
  const { visibleEntries } = filterFilesystemBrowseEntries(
    query.data?.entries ?? [],
    browse.filterQuery,
  );
  return (
    <div className="space-y-2" aria-label="Server folders">
      <p className="text-sm text-muted-foreground">Browse folders on this environment.</p>
      {query.error && <p role="alert">{query.error}</p>}
      {!access.canReadFiles && !access.isPending && (
        <p role="alert">{access.error ?? "This connection cannot browse host folders."}</p>
      )}
      {(access.isPending || (query.isPending && !query.data)) && <p>Loading folders...</p>}
      <div className="flex max-h-64 flex-col items-start gap-1 overflow-y-auto">
        {access.canReadFiles && browse.canBrowseUp && browse.parentPath && (
          <Button type="button" variant="ghost" onClick={() => onSelect(browse.parentPath!)}>
            <ArrowUpIcon />
            ..
          </Button>
        )}
        {visibleEntries.map((entry) => (
          <Button
            key={entry.fullPath}
            type="button"
            variant="ghost"
            onClick={() => onSelect(ensureBrowseDirectoryPath(entry.fullPath))}
          >
            <FolderIcon />
            {entry.name}
          </Button>
        ))}
        {query.data && visibleEntries.length === 0 && (
          <p className="text-sm text-muted-foreground">No matching folders.</p>
        )}
      </div>
    </div>
  );
}
