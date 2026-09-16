import { useAtomValue } from "@effect/atom-react";
import { isProjectFaviconFallbackUrl } from "@t3tools/shared/projectFavicon";
import { Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { projectFaviconUrlAtom } from "../../state/assets";
import type { HomeProjectScope } from "./homeThreadList";

/**
 * Favicon URL for each scope's representative project, in scope order, or
 * null where there is none. Native iOS menus take a URL rather than a view,
 * so this resolves what `ProjectFavicon` would otherwise load itself.
 */
export function useProjectScopeFaviconUrls(
  scopes: ReadonlyArray<HomeProjectScope>,
): ReadonlyArray<string | null> {
  const urlsAtom = useMemo(
    () =>
      Atom.make((get) =>
        scopes.map((scope) => {
          const { environmentId, workspaceRoot, faviconPath } = scope.representative;
          if (workspaceRoot == null) return null;
          const url = get(
            projectFaviconUrlAtom({ environmentId, cwd: workspaceRoot, faviconPath }),
          );
          return url === null || isProjectFaviconFallbackUrl(url) ? null : url;
        }),
      ),
    [scopes],
  );
  return useAtomValue(urlsAtom);
}
