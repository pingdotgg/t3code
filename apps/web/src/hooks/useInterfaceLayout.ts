import { useCallback, useMemo } from "react";

import {
  type InterfaceSurfaceId,
  type ResolvedSurfaceLayout,
  resolveSurfaceLayout,
} from "../interfaceLayout";
import { useClientSetting } from "./useSettings";

/** The user's arrangement of one surface, resolved against its current elements. */
export function useInterfaceLayout<S extends InterfaceSurfaceId>(
  surface: S,
): ResolvedSurfaceLayout<S> {
  const layout = useClientSetting("interfaceLayout");
  return useMemo(() => resolveSurfaceLayout(surface, layout), [layout, surface]);
}

/** Flex `order` for an element, so surfaces can rearrange without restructuring their markup. */
export function useInterfaceElementOrder<S extends InterfaceSurfaceId>(surface: S) {
  const { order } = useInterfaceLayout(surface);
  return useCallback((id: ResolvedSurfaceLayout<S>["order"][number]) => order.indexOf(id), [order]);
}
