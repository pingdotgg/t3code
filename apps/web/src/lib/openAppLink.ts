import { linkedEnvironmentNames } from "@t3tools/client-runtime/link-request";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { parseThreadAppLink } from "@t3tools/shared/threadLinks";
import { useNavigate } from "@tanstack/react-router";
import * as Effect from "effect/Effect";
import { type AsyncResult, type Atom, AtomRegistry } from "effect/reactivity";
import { msg } from "gt-react";

import { m } from "~/i18n/messages";
import { readLocalApi } from "~/localApi";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readThreadShell } from "~/state/entities";
import { orchestrationEnvironment } from "~/state/orchestration";
import { offersLinkedEnvironmentsAtom, peerLinkEnvironment } from "~/state/peerLinks";
import { environmentSummaries } from "~/state/presentation";
import { buildThreadRouteParams } from "~/threadRoutes";

import { openLinkedThreadRead } from "./sideChatPane";
import { resolveThreadLinkDestination, type ThreadLinkLookup } from "./threadLinkDestination";

type Navigate = ReturnType<typeof useNavigate>;

const readQuery = <A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>) =>
  Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, atom, { suspendOnWaiting: true }).pipe(
      Effect.timeout("10 seconds"),
      Effect.orElseSucceed(() => null),
    ),
  );

const identities = () => appAtomRegistry.get(environmentSummaries.identitiesAtom);

const threadLinkLookup: ThreadLinkLookup = {
  own: (environmentId) =>
    identities().some((environment) => environment.environmentId === environmentId)
      ? {
          connected: appAtomRegistry
            .get(environmentSummaries.connectedEnvironmentIdsAtom)
            .includes(environmentId),
        }
      : undefined,
  linkedLabel: async (viaEnvironmentId, environmentId) => {
    if (!appAtomRegistry.get(offersLinkedEnvironmentsAtom(viaEnvironmentId))) return undefined;
    const names = await readQuery(
      peerLinkEnvironment.names({ environmentId: viaEnvironmentId, input: {} }),
    );
    return linkedEnvironmentNames({
      links: names?.links ?? [],
      environments: identities(),
    }).get(environmentId);
  },
  loaded: (ref) => readThreadShell(ref) !== null,
  existing: async (environmentId, threadIds) => {
    const metadata = await readQuery(
      orchestrationEnvironment.threadLinkMetadata({ environmentId, input: { threadIds } }),
    );
    return new Set(threadIds.filter((threadId) => metadata?.[threadId] !== undefined));
  },
};

/**
 * A `t3-thread:` link opens its thread here, like a thread link in chat. Any other app link goes to
 * the OS, which the desktop app confirms with the user first.
 */
export async function openAppLink(input: {
  readonly url: string;
  /** The thread the link was shown in; a v1 thread link names no environment of its own. */
  readonly source: ScopedThreadRef | null;
  readonly navigate: Navigate;
}): Promise<void> {
  const threadLink = parseThreadAppLink(input.url);
  if (threadLink === null) {
    const api = readLocalApi();
    if (!api) throw new Error(m(msg("Link opening is unavailable.")));
    await api.shell.openAppLink(input.url);
    return;
  }
  const viaEnvironmentId: EnvironmentId | null =
    input.source?.environmentId ?? threadLink.environmentId;
  if (viaEnvironmentId === null) throw new Error(m(msg("Unable to open link.")));
  const destination = await resolveThreadLinkDestination(
    threadLink,
    viaEnvironmentId,
    threadLinkLookup,
  );
  if (destination.kind === "linked") {
    openLinkedThreadRead({
      panelRef: input.source,
      target: { viaEnvironmentId, ...destination.ref, label: destination.label, title: null },
      intent: "primary",
      navigate: input.navigate,
    });
    return;
  }
  await input.navigate({
    to: "/$environmentId/$threadId",
    params: buildThreadRouteParams(destination.ref),
  });
}

/** `openAppLink` for links shown in `source`'s thread. */
export function useOpenAppLink(source: ScopedThreadRef | null) {
  const navigate = useNavigate();
  return (url: string) => openAppLink({ url, source, navigate });
}
