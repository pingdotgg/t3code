import { Redirect, useLocalSearchParams } from "expo-router";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

export default function ReviewRoute() {
  const { environmentId, threadId } = useLocalSearchParams<{
    environmentId: EnvironmentId;
    threadId: ThreadId;
  }>();

  return (
    <Redirect
      href={{
        pathname: "/threads/[environmentId]/[threadId]/review",
        params: { environmentId, threadId },
      }}
    />
  );
}
