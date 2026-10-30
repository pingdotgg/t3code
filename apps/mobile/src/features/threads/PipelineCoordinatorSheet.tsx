import { useNavigation, type StaticScreenProps } from "@react-navigation/native";

import { PipelineCoordinatorScopeContext } from "./pipeline-coordinator-scope";
import { ThreadRouteScreen } from "./ThreadRouteScreen";
import { InspectorContentScope } from "./thread-inspector-preview";

/**
 * The pipeline coordinator's chat in a sheet. It is the parent thread's regular route (feed and
 * composer), mounted only while the sheet is open so the thread is not subscribed otherwise.
 */
export function PipelineCoordinatorRouteScreen(
  props: StaticScreenProps<{ readonly environmentId: string; readonly threadId: string }>,
) {
  const navigation = useNavigation();
  return (
    <PipelineCoordinatorScopeContext value>
      <InspectorContentScope>
        <ThreadRouteScreen
          route={props.route}
          inspectorPresentation={{ onClose: () => navigation.goBack() }}
        />
      </InspectorContentScope>
    </PipelineCoordinatorScopeContext>
  );
}
