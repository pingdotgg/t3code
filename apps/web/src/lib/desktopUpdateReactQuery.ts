import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { DesktopUpdateState } from "@t3tools/contracts";
import {
  desktopUpdateQueryKeys,
  desktopUpdateStateQueryOptions,
} from "./desktopUpdateReactQuery.shared";

export const setDesktopUpdateStateQueryData = (
  queryClient: QueryClient,
  state: DesktopUpdateState | null,
) => queryClient.setQueryData(desktopUpdateQueryKeys.state(), state);

export function useDesktopUpdateState() {
  const queryClient = useQueryClient();
  const query = useQuery(desktopUpdateStateQueryOptions());

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge || typeof bridge.onUpdateState !== "function") return;

    return bridge.onUpdateState((nextState) => {
      setDesktopUpdateStateQueryData(queryClient, nextState);
    });
  }, [queryClient]);

  return query;
}
