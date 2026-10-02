import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EMPTY_V2_ITEM_SUPPORT,
  resolveV2ItemSupport,
  v2ItemSupportEqual,
  type V2ItemSupport,
} from "@t3tools/client-runtime/state/item-support";
import type { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { environmentThreadDetails } from "./threads";

interface ItemSupportTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
}

function supportKey(target: ItemSupportTarget): string {
  return JSON.stringify(target);
}

function parseSupportKey(key: string): ItemSupportTarget {
  return JSON.parse(key) as ItemSupportTarget;
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
  }).pipe(Atom.withLabel(`mobile-v2-item-support:${key}`));
});

export function useV2ItemSupport(target: {
  readonly environmentId: EnvironmentId;
  readonly sourceThreadId: ThreadId;
  readonly sourceItemId: TurnItemId;
}): V2ItemSupport {
  return useAtomValue(
    itemSupportAtomFamily(
      supportKey({
        environmentId: target.environmentId,
        threadId: target.sourceThreadId,
        itemId: target.sourceItemId,
      }),
    ),
  );
}
