import {
  CommonActions,
  NavigationContainer,
  StackActions,
  type NavigationContainerRef,
} from "@react-navigation/native";
import { createContext, use, useCallback, useMemo, useRef, useState, type ReactNode } from "react";

import { appLinking } from "./linking";
import {
  buildPathFromRoute,
  getFocusedRoute,
  resolveNavigationTarget,
  type AppFocusedRoute,
  type AppNavigationInput,
  type AppStackParamList,
  type RouteParams,
} from "./route-model";

export type AppNavigation = {
  readonly push: (target: AppNavigationInput) => void;
  readonly replace: (target: AppNavigationInput) => void;
  readonly back: () => void;
  readonly dismiss: () => void;
  readonly dismissAll: () => void;
  readonly canGoBack: () => boolean;
  readonly setParams: (params: RouteParams) => void;
};

type AppNavigationContextValue = {
  readonly navigationRef: React.RefObject<NavigationContainerRef<AppStackParamList> | null>;
  readonly pathname: string;
  readonly params: RouteParams;
  readonly navigation: AppNavigation;
};

export const AppNavigationContext = createContext<AppNavigationContextValue | null>(null);

export function useAppNavigation(): AppNavigation {
  const context = use(AppNavigationContext);
  if (context === null) {
    throw new Error("useAppNavigation must be used within AppNavigationProvider");
  }
  return context.navigation;
}

export function useCurrentPathname(): string {
  const context = use(AppNavigationContext);
  if (context === null) {
    throw new Error("useCurrentPathname must be used within AppNavigationProvider");
  }
  return context.pathname;
}

export function useCurrentRouteParams<T extends RouteParams = RouteParams>(): T {
  const context = use(AppNavigationContext);
  if (context === null) {
    throw new Error("useCurrentRouteParams must be used within AppNavigationProvider");
  }
  return context.params as T;
}

export function createAppNavigation(
  navigationRef: React.RefObject<NavigationContainerRef<AppStackParamList> | null>,
): AppNavigation {
  const navigateWithAction = (
    input: AppNavigationInput,
    action: "push" | "replace" | "navigate",
  ): void => {
    const target = resolveNavigationTarget(input);
    const navigation = navigationRef.current;
    if (!navigation) {
      return;
    }

    if (action === "push") {
      navigation.dispatch(StackActions.push(target.name, target.params));
      return;
    }
    if (action === "replace") {
      navigation.dispatch(StackActions.replace(target.name, target.params));
      return;
    }
    navigation.dispatch(
      CommonActions.navigate({
        name: target.name,
        params: target.params,
      }),
    );
  };

  return {
    push: (href) => navigateWithAction(href, "push"),
    replace: (href) => navigateWithAction(href, "replace"),
    back: () => {
      const navigation = navigationRef.current;
      if (!navigation) return;
      if (navigation.canGoBack()) {
        navigation.goBack();
        return;
      }
      navigation.dispatch(StackActions.replace("Home"));
    },
    dismiss: () => {
      const navigation = navigationRef.current;
      if (!navigation) return;
      if (navigation.canGoBack()) {
        navigation.goBack();
        return;
      }
      navigation.dispatch(StackActions.replace("Home"));
    },
    dismissAll: () => {
      const navigation = navigationRef.current;
      if (!navigation) return;
      navigation.dispatch(
        CommonActions.reset({
          index: 0,
          routes: [{ name: "Home" }],
        }),
      );
    },
    canGoBack: () => navigationRef.current?.canGoBack() ?? false,
    setParams: (params) => {
      navigationRef.current?.dispatch(CommonActions.setParams(params));
    },
  };
}

export function AppNavigationProvider(props: { readonly children: ReactNode }) {
  const navigationRef = useRef<NavigationContainerRef<AppStackParamList>>(null);
  const [pathname, setPathname] = useState("/");
  const [params, setParams] = useState<RouteParams>({});
  const navigation = useMemo(() => createAppNavigation(navigationRef), []);
  const contextValue = useMemo(
    () => ({
      navigationRef,
      pathname,
      params,
      navigation,
    }),
    [navigation, params, pathname],
  );
  const syncState = useCallback(() => {
    const route = getFocusedRoute(navigationRef.current?.getRootState());
    if (!route) {
      setPathname("/");
      setParams({});
      return;
    }

    const current = pathAndParamsFromCurrentRoute(route);
    setPathname(current.pathname);
    setParams(current.params);
  }, []);

  return (
    <AppNavigationContext.Provider value={contextValue}>
      <NavigationContainer
        linking={appLinking}
        onReady={syncState}
        onStateChange={syncState}
        ref={navigationRef}
      >
        {props.children}
      </NavigationContainer>
    </AppNavigationContext.Provider>
  );
}

export function pathAndParamsFromCurrentRoute(route: AppFocusedRoute): {
  readonly pathname: string;
  readonly params: RouteParams;
} {
  return {
    pathname: buildPathFromRoute(route),
    params: (route.params ?? {}) as RouteParams,
  };
}
