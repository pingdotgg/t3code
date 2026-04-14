import { Link, Stack } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useMemo } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "../../lib/useThemeColor";

import { AppText as Text } from "../../components/AppText";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { groupProjectsByRepository } from "../../lib/repositoryGroups";
import { useRemoteCatalog } from "../../state/use-remote-catalog";
import { useRemoteEnvironmentState } from "../../state/use-remote-environment-registry";

export default function NewTaskRoute() {
  const { projects, threads } = useRemoteCatalog();
  const { savedConnectionsById } = useRemoteEnvironmentState();
  const insets = useSafeAreaInsets();
  const chevronColor = useThemeColor("--color-chevron");
  const borderSubtleColor = useThemeColor("--color-border-subtle");
  const repositoryGroups = useMemo(
    () => groupProjectsByRepository({ projects, threads }),
    [projects, threads],
  );
  const items = useMemo(
    () =>
      repositoryGroups
        .map((group) => {
          const project = group.projects[0]?.project;
          if (!project) {
            return null;
          }

          return {
            environmentId: project.environmentId,
            id: project.id,
            key: group.key,
            title: project.title,
            workspaceRoot: project.workspaceRoot,
          };
        })
        .filter((entry) => entry !== null),
    [repositoryGroups],
  );

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <Stack.Screen options={{ headerShown: false }} />

      <View style={{ minHeight: 16, paddingTop: 8 }} />

      <View className="items-center gap-1 px-5 pb-3 pt-4">
        <Text
          className="text-[12px] font-t3-bold uppercase text-foreground-muted"
          style={{ letterSpacing: 1 }}
        >
          New task
        </Text>
        <Text className="text-[28px] font-t3-bold">Choose project</Text>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 8,
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        {items.length === 0 ? (
          <View collapsable={false} className="items-center rounded-[24px] bg-card px-6 py-8">
            <Text className="text-[16px] font-medium text-foreground-muted">
              Loading projects...
            </Text>
          </View>
        ) : (
          <View collapsable={false} className="overflow-hidden rounded-[24px] bg-card">
            {items.map((item, index) => {
              const isFirst = index === 0;
              const isLast = index === items.length - 1;

              return (
                <Link
                  key={item.key}
                  href={{
                    pathname: "/new/draft",
                    params: {
                      environmentId: item.environmentId,
                      projectId: item.id,
                      title: item.title,
                    },
                  }}
                  asChild
                >
                  <Pressable
                    className="bg-card"
                    style={{
                      paddingHorizontal: 16,
                      paddingVertical: 18,
                      borderTopWidth: isFirst ? 0 : 1,
                      borderTopColor: borderSubtleColor,
                      borderTopLeftRadius: isFirst ? 24 : 0,
                      borderTopRightRadius: isFirst ? 24 : 0,
                      borderBottomLeftRadius: isLast ? 24 : 0,
                      borderBottomRightRadius: isLast ? 24 : 0,
                    }}
                  >
                    <View className="flex-row items-center justify-between gap-3">
                      <ProjectFavicon
                        size={22}
                        projectTitle={item.title}
                        httpBaseUrl={savedConnectionsById[item.environmentId]?.httpBaseUrl ?? null}
                        workspaceRoot={item.workspaceRoot}
                        bearerToken={savedConnectionsById[item.environmentId]?.bearerToken ?? null}
                      />
                      <View className="flex-1">
                        <Text className="text-[18px] font-t3-bold">{item.title}</Text>
                      </View>
                      <SymbolView
                        name="chevron.right"
                        size={14}
                        tintColor={chevronColor}
                        type="monochrome"
                      />
                    </View>
                  </Pressable>
                </Link>
              );
            })}
          </View>
        )}
      </ScrollView>
    </View>
  );
}
