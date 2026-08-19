import type { ClerkProviderProps } from "@clerk/react";
import { createMemoryHistory, type RouterHistory } from "@tanstack/react-router";

type ClerkRouterFn = NonNullable<ClerkProviderProps["routerPush"]>;

// The same marker clerk-js's own internals use to recognize a synthetic
// modal-router path (see @clerk/shared's url.js and queryStateParams.js,
// both matching this literal prefix to strip it back out). Reused here
// instead of asking the app's router whether it recognizes the path: this
// app's route tree has param routes (e.g. /$environmentId/$threadId), and
// TanStack Router's route matching is fuzzy by default, so a virtual path
// like /CLERK-ROUTER/VIRTUAL/sign-up can spuriously match one of those as a
// real route with a wildcard remainder. Checking Clerk's own marker instead
// is exact and doesn't depend on what routes the app happens to have.
const CLERK_VIRTUAL_PATH_MARKER = "CLERK-ROUTER/VIRTUAL/";

/**
 * Without routerPush/routerReplace, clerk-js falls back to a hard window
 * navigation whenever it needs to move to a step it treats as outside its
 * virtual modal router (sign-up transfer, MFA factors, password reset). In
 * Electron that hands the app's custom scheme a URL like
 * t3code://app/CLERK-ROUTER/VIRTUAL/sign-up#/continue, which the protocol
 * handler can't resolve, and the hard navigation tears down the mounted
 * React tree (and the Clerk modal with it), dropping the user back to
 * signed-out. So routerPush/routerReplace must always be given.
 *
 * But clerk-js also uses routerPush/routerReplace for those same synthetic
 * virtual-router paths, which never correspond to a real app route. Forwarding
 * one into the app's own history makes the app's TanStack Router try to
 * match it and, finding nothing real, blank the whole UI behind the Clerk
 * modal to "Not Found". So a virtual path is absorbed into an isolated,
 * unmounted history that clerk-js can still push/replace freely, while a
 * real path goes through the app's own history as a normal SPA transition.
 *
 * A real destination can still carry a leading "#" here: the app's own
 * redirect-target construction (authRedirect.ts) builds Electron redirect
 * URLs as t3code://app/#/current-page, and clerk-js hands this bridge
 * everything after the origin, hash included. Electron's history is a hash
 * history, so pushing that string unmodified would double the hash
 * (history.createHref would read back as "/#/#/current-page"). The part
 * after the first "#" is the actual in-app path the hash history expects.
 */
export function createClerkRouterBridge(history: RouterHistory): {
  routerPush: ClerkRouterFn;
  routerReplace: ClerkRouterFn;
} {
  const virtualHistory = createMemoryHistory({ initialEntries: ["/"] });

  function resolveDestination(to: string): { target: RouterHistory; path: string } {
    if (to.includes(CLERK_VIRTUAL_PATH_MARKER)) {
      return { target: virtualHistory, path: to };
    }
    const hashIndex = to.indexOf("#");
    const path = hashIndex === -1 ? to : to.slice(hashIndex + 1) || "/";
    return { target: history, path };
  }

  return {
    routerPush: (to) => {
      const { target, path } = resolveDestination(to);
      target.push(path);
    },
    routerReplace: (to) => {
      const { target, path } = resolveDestination(to);
      target.replace(path);
    },
  };
}
