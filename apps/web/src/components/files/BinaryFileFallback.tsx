import type { EnvironmentId } from "@t3tools/contracts";
import { Check, Copy, ExternalLink, FolderTree } from "lucide-react";

import { PierreEntryIcon } from "~/components/chat/PierreEntryIcon";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { useFileContextMenu } from "~/fileContextMenu";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useTheme } from "~/hooks/useTheme";

import { binaryFileInfo, fileMenuTarget } from "./binaryFileInfo";

export function BinaryFileFallback(props: { environmentId: EnvironmentId; path: string }) {
  const info = binaryFileInfo(props.path);
  const { resolvedTheme } = useTheme();
  const menu = useFileContextMenu(props.environmentId);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "file path",
    onError: (error) =>
      toastManager.add({ type: "error", title: "Could not copy path", description: error.message }),
  });
  const target = { environmentId: props.environmentId, ...fileMenuTarget(props.path) };

  return (
    <div className="scrollbar-gutter-both flex min-h-0 flex-1 flex-col overflow-auto px-6 py-8">
      <div className="m-auto flex w-full max-w-xs shrink-0 flex-col items-center gap-4 text-center">
        <PierreEntryIcon
          pathValue={props.path}
          kind="file"
          theme={resolvedTheme}
          className="size-12"
        />
        <div className="flex w-full flex-col gap-2">
          <h2 className="break-all text-sm font-medium">{info.name}</h2>
          <p className="text-xs text-muted-foreground">T3 Code can't preview this file type.</p>
        </div>
        <dl className="flex w-full justify-between gap-4 text-xs">
          <dt className="text-muted-foreground">Kind</dt>
          <dd className="break-all text-end">{info.kind}</dd>
        </dl>
        <div className="flex w-full flex-col gap-2">
          {info.canOpenDefault && menu.capabilities.canOpenDefault ? (
            <Button onClick={() => void menu.activate("open", target)}>
              <ExternalLink aria-hidden="true" />
              Open in default app
            </Button>
          ) : null}
          {menu.capabilities.revealLabel ? (
            <Button
              variant="outline"
              onClick={() => void menu.activate("reveal-in-folder", target)}
            >
              <FolderTree aria-hidden="true" />
              {menu.capabilities.revealLabel}
            </Button>
          ) : null}
          <Button variant="outline" onClick={() => copyToClipboard(props.path, undefined)}>
            {isCopied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {isCopied ? "Copied path" : "Copy path"}
          </Button>
        </div>
      </div>
    </div>
  );
}
