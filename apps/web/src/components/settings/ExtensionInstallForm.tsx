import {
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
  getFilesystemBrowseTabCompletion,
} from "@t3tools/client-runtime/state/filesystem";
import { appendBrowsePathSegment } from "@t3tools/client-runtime/state/projects";
import { filesystemEnvironment } from "../../state/filesystem";
import { useEnvironmentQuery } from "../../state/query";
import { useId, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { getAddProjectInitialQuery } from "@t3tools/client-runtime/operations/projects";
import {
  extensionCommandValue,
  extensionFailureMessage,
} from "@t3tools/client-runtime/state/extensions";
import { FolderOpenIcon, PackageIcon } from "lucide-react";
import { extensionEnvironment } from "../../state/extensions";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { ExtensionFolderBrowser } from "./ExtensionFolderBrowser";

export function ExtensionInstallForm({
  environmentId,
  baseDirectory,
  platform,
  onInstalled,
}: {
  environmentId: EnvironmentId;
  baseDirectory?: string;
  platform: string;
  onInstalled: () => void;
}) {
  const id = useId();
  const permission = useAtomValue(extensionEnvironment.install.permissionAtom(environmentId));
  const install = useAtomCommand(extensionEnvironment.install);
  const [source, setSource] = useState("");
  const [sourceType, setSourceType] = useState<"local" | "npm">("local");
  const [browsing, setBrowsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const browse = getFilesystemBrowsePath(source, platform, browsing && sourceType === "local");
  const listing = useEnvironmentQuery(
    browse.isBrowsing
      ? filesystemEnvironment.browse({
          environmentId,
          input: { partialPath: browse.directoryPath },
        })
      : null,
  );
  return (
    <form
      className="space-y-4 rounded-xl border border-border/60 bg-card/40 p-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
          extensionCommandValue(await install({ environmentId, input: { source, sourceType } }));
          setSource("");
          setBrowsing(false);
          onInstalled();
        } catch (cause) {
          setError(extensionFailureMessage(cause));
        }
        setBusy(false);
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-medium">Install an extension</h3>
        <ToggleGroup
          aria-label="Extension source type"
          value={[sourceType]}
          onValueChange={(values) => {
            const type = values[0];
            if (type === "local" || type === "npm") {
              setSourceType(type);
              setSource("");
              setBrowsing(false);
              setError(null);
            }
          }}
          disabled={busy}
        >
          <Toggle value="local">
            <FolderOpenIcon />
            Local folder
          </Toggle>
          <Toggle value="npm">
            <PackageIcon />
            npm package
          </Toggle>
        </ToggleGroup>
      </div>
      <div className="space-y-2">
        <Label htmlFor={id}>
          {sourceType === "local" ? "Folder on this server" : "Package name"}
        </Label>
        <div className="flex flex-wrap gap-2">
          <div className="min-w-40 flex-1">
            <Input
              id={id}
              aria-label="Extension source"
              value={source}
              disabled={busy}
              onKeyDown={(event) => {
                if (event.key !== "Tab" || event.shiftKey || !browse.isBrowsing || !listing.data)
                  return;
                const { visibleEntries } = filterFilesystemBrowseEntries(
                  listing.data.entries,
                  browse.filterQuery,
                );
                const completion = getFilesystemBrowseTabCompletion(
                  visibleEntries,
                  browse.filterQuery,
                );
                if (!completion) return;
                event.preventDefault();
                const path = appendBrowsePathSegment(browse.directoryPath, completion.name);
                setSource(completion.isComplete ? path : path.slice(0, -1));
              }}
              onChange={(event) => setSource(event.target.value)}
              placeholder={sourceType === "local" ? "/path/to/extension" : "@scope/package@version"}
            />
          </div>
          {sourceType === "local" && (
            <Button
              type="button"
              variant="outline"
              disabled={busy || !permission}
              aria-expanded={browsing}
              onClick={() => {
                if (!source.trim()) setSource(getAddProjectInitialQuery(baseDirectory));
                setBrowsing(!browsing);
              }}
            >
              <FolderOpenIcon />
              {browsing ? "Hide folders" : "Browse"}
            </Button>
          )}
        </div>
        {sourceType === "npm" && (
          <p className="text-xs text-muted-foreground">
            Use a package name or pin a version with @version.
          </p>
        )}
      </div>
      {browsing && sourceType === "local" && (
        <ExtensionFolderBrowser
          environmentId={environmentId}
          platform={platform}
          path={source}
          onSelect={setSource}
        />
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-md text-xs text-muted-foreground">
          Extensions have full access to this server. Only install code you trust.
        </p>
        <Button type="submit" disabled={busy || !source.trim() || !permission}>
          {busy ? "Installing..." : "Install extension"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="break-words text-sm text-destructive-foreground">
          {error}
        </p>
      )}
    </form>
  );
}
