import {
  createNavigationContainerRef,
  type NavigationContainerRef,
} from "@react-navigation/native";

/**
 * The app's single navigation container. Work that outlives a screen (a draft
 * route's branch checkout) navigates through it.
 */
export const rootNavigationRef = createNavigationContainerRef<ReactNavigation.RootParamList>();

/**
 * Ref callback for the container. Android activity replacement mounts the new
 * root before the old one unmounts, so the old container must not clear the
 * ref the new one already owns.
 */
export function attachRootNavigation(
  navigation: NavigationContainerRef<ReactNavigation.RootParamList> | null,
): () => void {
  rootNavigationRef.current = navigation;
  return () => {
    if (rootNavigationRef.current === navigation) rootNavigationRef.current = null;
  };
}
