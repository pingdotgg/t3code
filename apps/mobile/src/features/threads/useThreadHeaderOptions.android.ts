import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import { serverEnvironment } from "../../state/server";
import type { useThreadHeaderOptions as useIosThreadHeaderOptions } from "./useThreadHeaderOptions";

export function useThreadHeaderOptions(
  props: Parameters<typeof useIosThreadHeaderOptions>[0],
): ReturnType<typeof useIosThreadHeaderOptions> {
  const canViewScreen = useAtomValue(
    serverEnvironment.captureHostScreen.permissionAtom(
      EnvironmentId.make(props.gitControls.environmentId),
    ),
  );
  return {
    openHostScreen: canViewScreen ? props.onOpenHostScreen : undefined,
    options: { contentStyle: { backgroundColor: props.headerColor } },
    // Android renders header actions as children, not native item factories.
    optionsVersion: [],
    sidebar: true,
    fallback: null,
  };
}
