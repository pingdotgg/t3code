import { Redirect, useLocalSearchParams } from "expo-router";

export default function ReviewRoute() {
  const { environmentId, threadId } = useLocalSearchParams<{
    environmentId: string;
    threadId: string;
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
