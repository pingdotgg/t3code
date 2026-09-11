import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";
import * as Linking from "expo-linking";
import { useEffect } from "react";
import { environmentCatalog } from "../connection/catalog";
import { environmentPresentations } from "../state/presentation";
import { publishSubscriptionUsage } from "./publishSubscriptionUsage";
import { buildSubscriptionUsageSnapshot } from "./subscriptionUsageSnapshot";

// Isolate quota changes from the much busier thread/config presentation stream.
const snapshotAtom = Atom.make((get) =>
  buildSubscriptionUsageSnapshot(
    get(environmentPresentations.presentationsAtom),
    Linking.createURL("settings/usage", { queryParams: { tab: "limits" } }),
  ),
).pipe(Atom.withEquality((a, b) => JSON.stringify(a) === JSON.stringify(b)));

export function SubscriptionUsageCoordinator() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const snapshot = useAtomValue(snapshotAtom);
  useEffect(() => {
    if (!catalog.isReady) return;
    void Promise.resolve()
      .then(() => publishSubscriptionUsage(snapshot))
      .catch((error: unknown) => {
        console.warn("Could not update subscription usage widget", error);
      });
  }, [catalog.isReady, snapshot]);
  return null;
}
