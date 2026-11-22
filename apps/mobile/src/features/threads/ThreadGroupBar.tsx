import { msg, useMessages } from "gt-react-native";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { isGroupActive } from "@t3tools/client-runtime/state/thread-group";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import { useEnvironmentServerConfig } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { alertGroupCommandFailure } from "./groupCommandFailure";
import { useOpenLinkedThread } from "./useOpenLinkedThread";

export function ThreadGroupBar({ thread }: { readonly thread: EnvironmentThreadShell }) {
  const m = useMessages();
  const { environmentId, group } = thread;
  const navigation = useNavigation();
  const config = useEnvironmentServerConfig(environmentId);
  const canInvite = useAtomValue(
    orchestrationEnvironment.inviteToGroup.permissionAtom(environmentId),
  );
  const canRemove = useAtomValue(
    orchestrationEnvironment.removeFromGroup.permissionAtom(environmentId),
  );
  const canEnd = useAtomValue(orchestrationEnvironment.endGroup.permissionAtom(environmentId));
  const inviteAvailable =
    canInvite &&
    config?.settings.groupConversationsEnabled === true &&
    thread.lineage.sideChat !== true &&
    thread.lineage.relationshipToParent !== "subagent";
  const remove = useAtomCommand(orchestrationEnvironment.removeFromGroup);
  const end = useAtomCommand(orchestrationEnvironment.endGroup);
  const openWork = useOpenLinkedThread();
  if (!isGroupActive(group)) return null;

  return (
    // The feed scrolls beneath the composer dock, so text here needs its own surface.
    <View className="mx-3 mb-2 gap-1 rounded-2xl bg-card px-3 py-1.5">
      <View className="flex-row items-center gap-2">
        <ScrollView className="min-w-0 flex-1" horizontal showsHorizontalScrollIndicator={false}>
          <View className="flex-row items-center gap-2">
            <Text
              accessibilityLabel={m(msg("{name}, primary"), { name: group.primary.label })}
              className="text-xs font-t3-medium text-foreground"
            >
              ★ {group.primary.label}
            </Text>
            {group.seats
              .filter((seat) => seat.status === "seated")
              .map((seat) => (
                <Menu
                  key={seat.threadId}
                  actions={[
                    { id: "work", title: m(msg("Open work")), image: "arrow.up.right" },
                    {
                      id: "remove",
                      title: m(msg("Remove")),
                      image: "person.fill.xmark",
                      attributes: { destructive: true, disabled: !canRemove },
                    },
                  ]}
                  onPressAction={({ nativeEvent }) => {
                    if (nativeEvent.event === "work")
                      openWork({ environmentId, threadId: seat.threadId });
                    if (nativeEvent.event === "remove")
                      void remove({
                        environmentId,
                        input: { threadId: thread.id, seatThreadId: seat.threadId },
                      }).then((result) =>
                        alertGroupCommandFailure(
                          m(msg("Could not remove {name}"), { name: seat.label }),
                          result,
                        ),
                      );
                  }}
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={m(msg("{name}, group member actions"), {
                      name: seat.label,
                    })}
                    className="rounded-full border border-border bg-subtle px-3 py-2"
                  >
                    <Text className="text-xs text-foreground">{seat.label}</Text>
                  </Pressable>
                </Menu>
              ))}
          </View>
        </ScrollView>
        {/* Invite and the way out stay on screen however many members the row scrolls past. */}
        <Menu
          actions={[
            ...(inviteAvailable
              ? [{ id: "invite", title: m(msg("Invite a model")), image: "person.badge.plus" }]
              : []),
            {
              id: "end",
              title: m(msg("End group · Continue with {name}"), { name: group.primary.label }),
              image: "rectangle.portrait.and.arrow.right",
              attributes: { disabled: !canEnd },
            },
          ]}
          onPressAction={({ nativeEvent }) => {
            if (nativeEvent.event === "invite")
              navigation.navigate("ThreadGroupInvite", { environmentId, threadId: thread.id });
            if (nativeEvent.event === "end")
              void end({ environmentId, input: { threadId: thread.id } }).then((result) =>
                alertGroupCommandFailure(m(msg("Could not end the group")), result),
              );
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={m(msg("Group actions"))}
            className="rounded-full p-2"
            hitSlop={8}
          >
            <SymbolView name="ellipsis" size={16} tintColorClassName="accent-foreground" />
          </Pressable>
        </Menu>
      </View>
      {group.discussion === null && group.closedBecause === "budget" ? (
        <Text accessibilityRole="text" className="text-xs text-foreground-muted">
          {m(msg("A member has unanswered replies. Any message continues."))}
        </Text>
      ) : null}
    </View>
  );
}
