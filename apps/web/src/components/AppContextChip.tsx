import type { AppContextRecord, EnvironmentId } from "@t3tools/contracts";
import { AppWindowIcon } from "lucide-react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { cn } from "~/lib/utils";
import { ContextChip, ContextChipLabel } from "./ContextChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/** The app bundle's own icon from its machine, or a generic app glyph until it loads. */
export function LocalAppIcon(props: {
  environmentId: EnvironmentId | null;
  appPath: string;
  className?: string;
}) {
  const asset = useAssetUrlState(props.environmentId, {
    _tag: "native-app-icon",
    app: { _tag: "app-path", path: props.appPath },
  });
  if (asset._tag !== "Success") {
    return <AppWindowIcon aria-hidden="true" className={props.className} />;
  }
  return (
    <img
      src={asset.url}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={cn("object-contain", props.className)}
    />
  );
}

/** Inline chip for a mentioned desktop app, in the composer and in sent messages. */
export function AppContextChip(props: {
  record: Pick<AppContextRecord, "appPath" | "label">;
  environmentId: EnvironmentId | null;
  copyMarkdown?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip
            kind="app"
            tabIndex={0}
            aria-label={`App, ${props.record.label}`}
            data-markdown-copy={props.copyMarkdown}
          >
            <LocalAppIcon
              environmentId={props.environmentId}
              appPath={props.record.appPath}
              className="size-[1em] self-center"
            />
            <ContextChipLabel>{props.record.label}</ContextChipLabel>
          </ContextChip>
        }
      />
      <TooltipPopup side="top">{props.record.appPath}</TooltipPopup>
    </Tooltip>
  );
}
