import { useAtomValue } from "@effect/atom-react";
import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadStructure } from "@t3tools/client-runtime/state/models";
import {
  findLatestTaskList,
  taskListProgress,
} from "@t3tools/client-runtime/state/thread-execution";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { T, useGT } from "gt-react-native";
import { ScrollView, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { withUniwind } from "uniwind";

import { AppText as Text } from "../../components/ui/AppText";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SymbolView } from "../../components/ui/AppSymbol";
import { environmentThreadDetails } from "../../state/threads";

const EMPTY_THREAD_ATOM = Atom.make<EnvironmentThreadStructure | null>(null);
const ThemedSvg = withUniwind(Svg);

export function useThreadTaskList(target: ScopedThreadRef | null) {
  return useAtomValue(
    target === null ? EMPTY_THREAD_ATOM : environmentThreadDetails.quietThreadAtom(target),
    (thread) => findLatestTaskList(thread?.projection ?? null),
  );
}

export function useThreadTasksAction(target: ScopedThreadRef | null) {
  const gt = useGT();
  const navigation = useNavigation();
  const tasks = useThreadTaskList(target);
  return tasks === null || target === null
    ? null
    : {
        accessibilityLabel: gt("Tasks"),
        icon: "list.number" as const,
        overflowOnly: true,
        onPress: () => navigation.navigate("ThreadTasks", target),
      };
}

export function TaskProgressRing({ percentage }: { readonly percentage: number }) {
  return (
    <ThemedSvg
      width={14}
      height={14}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      colorClassName="accent-foreground"
      accessible={false}
    >
      <Circle cx={8} cy={8} r={6} opacity={0.2} />
      <Circle
        cx={8}
        cy={8}
        r={6}
        strokeDasharray={`${(percentage / 100) * 12 * Math.PI} ${12 * Math.PI}`}
        rotation={-90}
        origin="8, 8"
      />
    </ThemedSvg>
  );
}

export function ThreadTasksSheet({
  route,
}: StaticScreenProps<{
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}>) {
  const gt = useGT();
  const navigation = useNavigation();
  const plan = useThreadTaskList(scopeThreadRef(route.params.environmentId, route.params.threadId));
  const progress = taskListProgress(plan?.steps ?? []);
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <SheetHeader title={gt("Tasks")} onClose={() => navigation.goBack()} />
      <ScreenContent>
        <ScrollView
          nestedScrollEnabled
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="px-5 pb-8"
        >
          {plan === null ? (
            <Text className="py-6 text-center text-sm text-foreground-muted">
              <T>No tasks in this thread.</T>
            </Text>
          ) : (
            <>
              <View className="flex-row items-center gap-2 py-3">
                <TaskProgressRing percentage={progress.percentage} />
                <Text className="font-t3-medium text-sm tabular-nums">{progress.percentage}%</Text>
                <Text className="text-xs text-foreground-muted tabular-nums">
                  {progress.completed}/{progress.total}
                </Text>
              </View>
              {plan.steps.map((step) => (
                <View
                  key={step.id}
                  className="flex-row items-start gap-3 border-b border-border py-3.5"
                >
                  <SymbolView
                    name={
                      step.status === "completed"
                        ? "checkmark.circle"
                        : step.status === "running"
                          ? "circle.fill"
                          : "circle"
                    }
                    size={15}
                    tintColorClassName={
                      step.status === "completed"
                        ? "accent-success-foreground"
                        : "accent-foreground-muted"
                    }
                  />
                  <View className="min-w-0 flex-1">
                    <Text className="text-sm">{step.text}</Text>
                    <Text className="text-xs text-foreground-muted">
                      {step.status === "completed"
                        ? gt("Completed")
                        : step.status === "running"
                          ? gt("Running")
                          : gt("Pending")}
                    </Text>
                  </View>
                </View>
              ))}
            </>
          )}
        </ScrollView>
      </ScreenContent>
    </View>
  );
}
