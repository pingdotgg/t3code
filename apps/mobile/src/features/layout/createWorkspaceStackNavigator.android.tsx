import {
  createNavigatorFactory,
  StackRouter,
  useNavigationBuilder,
  type NavigatorTypeBagBase,
  type ParamListBase,
  type StackActionHelpers,
  type StackNavigationState,
  type StackRouterOptions,
  type StaticConfig,
  type TypedNavigator,
} from "@react-navigation/native";
import {
  NativeStackView,
  type NativeStackNavigationEventMap,
  type NativeStackNavigationOptions,
  type NativeStackNavigatorProps,
  type NativeStackTypeBag,
} from "@react-navigation/native-stack";
import { use, type ComponentProps } from "react";

import { RoutedFormSheetContext } from "../../components/ui/RoutedFormSheetContext";

import { projectStackPresentation } from "../../native/workspace-stack-projection";
import {
  WorkspaceColumnsRendererContext,
  WorkspacePresentationHostContext,
} from "./workspace-presentation-context";

type ViewProps = ComponentProps<typeof NativeStackView>;
type Descriptor = ViewProps["descriptors"][string];
type Route = ViewProps["state"]["routes"][number];

function WorkspaceStackView(props: ViewProps) {
  const renderColumns = use(WorkspaceColumnsRendererContext);
  if (!renderColumns) return <NativeStackView {...props} />;

  const isOverlay = (route: Route) => {
    const descriptor = props.descriptors[route.key] ?? props.describe(route, true);
    const presentation = descriptor.options.presentation;
    return presentation !== undefined && presentation !== "card";
  };
  const projection = projectStackPresentation(props.state, isOverlay);
  const workspaceRoutes = projection.workspace;
  const visibleRoute = workspaceRoutes.at(-1);
  if (!visibleRoute) return <NativeStackView {...props} />;

  const visibleDescriptor = props.descriptors[visibleRoute.key]!;
  const baseRoute = { key: `${props.state.key}:workspace`, name: "Workspace" };
  const baseDescriptor: Descriptor = {
    ...visibleDescriptor,
    options: { headerShown: false, freezeOnBlur: false },
    render: () =>
      renderColumns(
        <NativeStackView
          {...props}
          state={{
            ...props.state,
            routes: workspaceRoutes,
            index: workspaceRoutes.length - 1,
            preloadedRoutes: props.state.preloadedRoutes.filter((route) => !isOverlay(route)),
          }}
        />,
      ),
  };
  const routes = [baseRoute, ...projection.overlays];
  return (
    <NativeStackView
      {...props}
      presentationEnvelope
      state={{
        ...props.state,
        routes,
        index: routes.length - 1,
        preloadedRoutes: props.state.preloadedRoutes.filter(isOverlay),
      }}
      descriptors={{ ...props.descriptors, [baseRoute.key]: baseDescriptor }}
    />
  );
}

function WorkspaceStackNavigator({
  id,
  initialRouteName,
  UNSTABLE_routeNamesChangeBehavior,
  children,
  layout,
  screenListeners,
  screenOptions,
  screenLayout,
  UNSTABLE_router,
  ...rest
}: NativeStackNavigatorProps) {
  const { state, describe, descriptors, navigation, NavigationContent } = useNavigationBuilder<
    StackNavigationState<ParamListBase>,
    StackRouterOptions,
    StackActionHelpers<ParamListBase>,
    NativeStackNavigationOptions,
    NativeStackNavigationEventMap
  >(StackRouter, {
    id,
    initialRouteName,
    UNSTABLE_routeNamesChangeBehavior,
    children,
    layout,
    screenListeners,
    screenOptions,
    screenLayout,
    UNSTABLE_router,
  });
  return (
    <WorkspacePresentationHostContext value>
      <NavigationContent>
        <WorkspaceStackView
          {...rest}
          state={state}
          describe={describe}
          descriptors={Object.fromEntries(
            Object.entries(descriptors).map(([key, descriptor]) => [
              key,
              descriptor.options.presentation === "formSheet"
                ? {
                    ...descriptor,
                    render: () => (
                      <RoutedFormSheetContext value>{descriptor.render()}</RoutedFormSheetContext>
                    ),
                  }
                : descriptor,
            ]),
          )}
          navigation={navigation}
        />
      </NavigationContent>
    </WorkspacePresentationHostContext>
  );
}

type WorkspaceTypeBag<
  ParamList extends ParamListBase,
  NavigatorID extends string | undefined,
> = Omit<NativeStackTypeBag<ParamList, NavigatorID>, "Navigator"> & {
  Navigator: typeof WorkspaceStackNavigator;
};

export function createWorkspaceStackNavigator<
  const ParamList extends ParamListBase,
  const NavigatorID extends string | undefined = string | undefined,
  const TypeBag extends NavigatorTypeBagBase = WorkspaceTypeBag<ParamList, NavigatorID>,
  const Config extends StaticConfig<TypeBag> = StaticConfig<TypeBag>,
>(config?: Config): TypedNavigator<TypeBag, Config> {
  return createNavigatorFactory(WorkspaceStackNavigator)(config);
}
