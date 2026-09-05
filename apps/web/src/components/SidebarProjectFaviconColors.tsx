import type { EnvironmentId, ProjectIconOverride } from "@t3tools/contracts";
import { memo, useEffect, useMemo } from "react";

import { useProjectFaviconColor } from "./ProjectFavicon";

export interface SidebarProjectFaviconColorSource {
  readonly projectKey: string;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly faviconPath?: string | null | undefined;
  readonly projectIcon?: ProjectIconOverride | null | undefined;
}

export function distinctSidebarProjectFaviconColorSources(
  sources: readonly SidebarProjectFaviconColorSource[],
): SidebarProjectFaviconColorSource[] {
  return [
    ...new Map(sources.map((source) => [source.projectKey, source] as const)).values(),
  ].filter((source) => source.projectIcon == null);
}

const SidebarProjectFaviconColorResolver = memo(function SidebarProjectFaviconColorResolver(props: {
  readonly source: SidebarProjectFaviconColorSource;
  readonly onColor: (projectKey: string, color: string | null) => void;
}) {
  const { onColor, source } = props;
  const color = useProjectFaviconColor({
    environmentId: source.environmentId,
    cwd: source.cwd,
    faviconPath: source.faviconPath,
  });

  useEffect(() => {
    onColor(source.projectKey, color);
  }, [color, onColor, source.projectKey]);

  useEffect(
    () => () => {
      onColor(source.projectKey, null);
    },
    [onColor, source.projectKey],
  );

  return null;
});

export const SidebarProjectFaviconColorResolvers = memo(
  function SidebarProjectFaviconColorResolvers(props: {
    readonly sources: readonly SidebarProjectFaviconColorSource[];
    readonly onColor: (projectKey: string, color: string | null) => void;
  }) {
    const sources = useMemo(
      () => distinctSidebarProjectFaviconColorSources(props.sources),
      [props.sources],
    );

    return sources.map((source) => (
      <SidebarProjectFaviconColorResolver
        key={source.projectKey}
        source={source}
        onColor={props.onColor}
      />
    ));
  },
);
