import { useAtomValue } from "@effect/atom-react";
import {
  EMPTY_V2_ITEM_SUPPORT,
  resolveV2ItemSupport,
  v2ItemSupportEqual,
  type V2ItemSupport,
} from "@t3tools/client-runtime/state/item-support";
import type { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { Atom } from "effect/unstable/reactivity";

import { environmentThreadDetails } from "./threads";

function supportKey(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
}): string {
  return JSON.stringify(input);
}

function parseSupportKey(key: string): {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
} {
  return JSON.parse(key) as {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly itemId: TurnItemId;
  };
}

const itemSupportAtomFamily = Atom.family((key: string) => {
  const target = parseSupportKey(key);
  const ref = scopeThreadRef(target.environmentId, target.threadId);
  let previous = EMPTY_V2_ITEM_SUPPORT;
  return Atom.make((get): V2ItemSupport => {
    const scoped = get(environmentThreadDetails.threadAtom(ref));
    if (scoped === null) return EMPTY_V2_ITEM_SUPPORT;
    const next = resolveV2ItemSupport(scoped.projection, target.itemId);
    if (v2ItemSupportEqual(previous, next)) return previous;
    previous = next;
    return next;
  }).pipe(Atom.withLabel(`web-v2-item-support:${key}`));
});

export function useV2ItemSupport(input: {
  readonly environmentId: EnvironmentId;
  readonly sourceThreadId: ThreadId;
  readonly sourceItemId: TurnItemId;
}): V2ItemSupport {
  return useAtomValue(
    itemSupportAtomFamily(
      supportKey({
        environmentId: input.environmentId,
        threadId: input.sourceThreadId,
        itemId: input.sourceItemId,
      }),
    ),
  );
}
