import { useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Linking from "expo-linking";
import { useEffect } from "react";
import { Platform } from "react-native";
import { environmentCatalog } from "../connection/catalog";
import { environmentPresentations } from "../state/presentation";
import { publishSubscriptionUsage } from "./publishSubscriptionUsage";
import { useSubscriptionUsage } from "./useSubscriptionUsage";
import { buildSubscriptionUsageSnapshot } from "./subscriptionUsageSnapshot";
import { withAndroidWidgetSnapshots } from "./androidSubscriptionUsageSnapshot";
import { resolveWidgetPreferences } from "./subscriptionWidgetPreferences";
import { mobilePreferencesAtom } from "../state/preferences";

// Isolate quota changes from the much busier thread/config presentation stream.
const snapshotAtom = Atom.make((get) => {
  const presentations = get(environmentPresentations.presentationsAtom);
  const snapshot = buildSubscriptionUsageSnapshot(
    presentations,
    Linking.createURL("settings/usage", { queryParams: { tab: "limits" } }),
    Platform.OS === "android" ? Infinity : 6,
  );
  if (Platform.OS !== "android") return snapshot;
  const preferences = get(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferences)
    ? withAndroidWidgetSnapshots(
        { ...snapshot, androidWidgetUrl: Linking.createURL("settings/usage-widget") },
        presentations,
        resolveWidgetPreferences(preferences.value.subscriptionWidgets),
      )
    : null;
}).pipe(Atom.withEquality((a, b) => JSON.stringify(a) === JSON.stringify(b)));

export function SubscriptionUsageCoordinator() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const snapshot = useAtomValue(snapshotAtom);
  useSubscriptionUsage(catalog.isReady);
  useEffect(() => {
    if (!catalog.isReady || snapshot === null) return;
    void Promise.resolve()
      .then(() => publishSubscriptionUsage(snapshot))
      .catch((error: unknown) => {
        console.warn("Could not update subscription usage widget", error);
      });
  }, [catalog.isReady, snapshot]);
  return null;
}
