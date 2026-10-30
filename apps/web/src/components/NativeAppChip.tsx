import { EnvironmentId, type CuaApplication } from "@t3tools/contracts";
import { AppWindowIcon } from "lucide-react";
import { useState } from "react";
import { useAssetUrlState } from "~/assets/assetUrls";
import { ContextChip, ContextChipLabel } from "./ContextChip";

export function NativeAppIcon({
  app,
  environmentId,
}: {
  app: CuaApplication;
  environmentId: string;
}) {
  const reference =
    app.bundleId && /^[A-Za-z0-9._-]+(?:![A-Za-z0-9._-]+)?$/u.test(app.bundleId)
      ? { _tag: "app-id" as const, appId: app.bundleId }
      : { _tag: "display-name" as const, displayName: app.name };
  const icon = useAssetUrlState(EnvironmentId.make(environmentId), {
    _tag: "native-app-icon",
    app: reference,
  });
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const url = icon._tag === "Success" ? icon.url : null;
  const loaded = url !== null && loadedUrl === url && failedUrl !== url;
  return (
    <span
      aria-hidden="true"
      className="relative inline-flex size-4 shrink-0 items-center justify-center"
    >
      {!loaded ? <AppWindowIcon className="size-4" /> : null}
      {url !== null && failedUrl !== url ? (
        <img
          src={url}
          alt=""
          hidden={!loaded}
          className="absolute inset-0 size-full object-contain"
          onLoad={() => setLoadedUrl(url)}
          onError={() => setFailedUrl(url)}
        />
      ) : null}
    </span>
  );
}

export function NativeAppChip(props: { app: CuaApplication; environmentId: string }) {
  return (
    <ContextChip kind="mention" title={`Application: ${props.app.name}`}>
      <NativeAppIcon {...props} />
      <ContextChipLabel>{props.app.name}</ContextChipLabel>
    </ContextChip>
  );
}
