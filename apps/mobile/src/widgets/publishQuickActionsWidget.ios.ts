import { requireOptionalNativeModule } from "expo";
import * as Linking from "expo-linking";

import type { RecentThreadShortcut } from "../persistence/imperative";
import { quickActionsProps } from "./quickActionsSnapshot";

export async function publishQuickActionsWidget(recents: ReadonlyArray<RecentThreadShortcut>) {
  if (!requireOptionalNativeModule("ExpoWidgets")) return;
  const { default: widget } = await import("./QuickActionsWidget");
  widget.updateSnapshot(quickActionsProps(Linking.createURL(""), recents));
}
