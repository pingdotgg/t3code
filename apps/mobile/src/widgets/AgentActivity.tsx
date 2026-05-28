import { HStack, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import { font, foregroundStyle, lineLimit, padding } from "@expo/ui/swift-ui/modifiers";
import {
  createLiveActivity,
  type LiveActivityComponent,
  type LiveActivityLayout,
} from "expo-widgets";
import { formatAgentActivityUpdatedAtLabel } from "../features/agent-awareness/updatedAtLabel";

type LiveActivityEnvironment = Parameters<LiveActivityComponent<AgentActivityProps>>[1];

export type AgentActivityPhase =
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "stale";

export interface AgentActivityRowProps {
  readonly environmentId: string;
  readonly threadId: string;
  readonly projectTitle: string;
  readonly threadTitle: string;
  readonly modelTitle: string;
  readonly phase: AgentActivityPhase;
  readonly status: string;
  readonly updatedAt: string;
  readonly deepLink: string;
}

export interface AgentActivityProps {
  readonly title: string;
  readonly subtitle: string;
  readonly activeCount: number;
  readonly updatedAt: string;
  readonly activities: ReadonlyArray<AgentActivityRowProps>;
}

function AgentActivity(
  props: AgentActivityProps,
  _environment: LiveActivityEnvironment,
): LiveActivityLayout {
  "widget";

  const row0 = props.activities[0];
  const row1 = props.activities[1];
  const row2 = props.activities[2];
  const updatedAt = formatAgentActivityUpdatedAtLabel(props.updatedAt);
  const activeLabel = `${props.activeCount} active`;
  const tint =
    row0?.phase === "waiting_for_approval" || row0?.phase === "waiting_for_input"
      ? "#f97316"
      : row0?.phase === "failed"
        ? "#ef4444"
        : "#14b8a6";

  return {
    banner: (
      <VStack modifiers={[padding({ all: 14 })]}>
        <HStack>
          <VStack>
            <Text modifiers={[font({ weight: "bold", size: 15 }), foregroundStyle("#ffffff")]}>
              {props.title}
            </Text>
            <Text modifiers={[font({ size: 12 }), foregroundStyle("#cbd5e1"), lineLimit(1)]}>
              {props.subtitle}
            </Text>
          </VStack>
          <Spacer minLength={8} />
          <Text modifiers={[font({ weight: "semibold", size: 12 }), foregroundStyle(tint)]}>
            {activeLabel}
          </Text>
        </HStack>
        {row0 ? (
          <HStack modifiers={[padding({ vertical: 4 })]}>
            <VStack>
              <Text
                modifiers={[
                  font({ weight: "bold", size: 13 }),
                  foregroundStyle("#ffffff"),
                  lineLimit(1),
                ]}
              >
                {row0.threadTitle}
              </Text>
              <Text modifiers={[font({ size: 11 }), foregroundStyle("#cbd5e1"), lineLimit(1)]}>
                {row0.projectTitle} - {row0.modelTitle}
              </Text>
            </VStack>
            <Spacer minLength={8} />
            <Text modifiers={[font({ weight: "semibold", size: 11 }), foregroundStyle(tint)]}>
              {row0.status}
            </Text>
          </HStack>
        ) : null}
        {row1 ? (
          <HStack modifiers={[padding({ vertical: 4 })]}>
            <VStack>
              <Text
                modifiers={[
                  font({ weight: "bold", size: 13 }),
                  foregroundStyle("#ffffff"),
                  lineLimit(1),
                ]}
              >
                {row1.threadTitle}
              </Text>
              <Text modifiers={[font({ size: 11 }), foregroundStyle("#cbd5e1"), lineLimit(1)]}>
                {row1.projectTitle} - {row1.modelTitle}
              </Text>
            </VStack>
            <Spacer minLength={8} />
            <Text modifiers={[font({ weight: "semibold", size: 11 }), foregroundStyle(tint)]}>
              {row1.status}
            </Text>
          </HStack>
        ) : null}
        {row2 ? (
          <HStack modifiers={[padding({ vertical: 4 })]}>
            <VStack>
              <Text
                modifiers={[
                  font({ weight: "bold", size: 13 }),
                  foregroundStyle("#ffffff"),
                  lineLimit(1),
                ]}
              >
                {row2.threadTitle}
              </Text>
              <Text modifiers={[font({ size: 11 }), foregroundStyle("#cbd5e1"), lineLimit(1)]}>
                {row2.projectTitle} - {row2.modelTitle}
              </Text>
            </VStack>
            <Spacer minLength={8} />
            <Text modifiers={[font({ weight: "semibold", size: 11 }), foregroundStyle(tint)]}>
              {row2.status}
            </Text>
          </HStack>
        ) : null}
        <Text modifiers={[font({ size: 11 }), foregroundStyle("#94a3b8")]}>
          Updated {updatedAt}
        </Text>
      </VStack>
    ),
    bannerSmall: (
      <VStack modifiers={[padding({ all: 12 })]}>
        <HStack>
          <Text modifiers={[font({ weight: "bold", size: 13 }), foregroundStyle("#ffffff")]}>
            {props.title}
          </Text>
          <Spacer minLength={6} />
          <Text modifiers={[font({ weight: "semibold", size: 12 }), foregroundStyle(tint)]}>
            {activeLabel}
          </Text>
        </HStack>
        {row0 ? (
          <VStack>
            <Text
              modifiers={[
                font({ weight: "bold", size: 12 }),
                foregroundStyle("#ffffff"),
                lineLimit(1),
              ]}
            >
              {row0.threadTitle}
            </Text>
            <Text modifiers={[font({ size: 11 }), foregroundStyle("#cbd5e1"), lineLimit(1)]}>
              {row0.projectTitle} - {row0.status}
            </Text>
          </VStack>
        ) : null}
      </VStack>
    ),
    compactLeading: (
      <Text modifiers={[font({ weight: "bold", size: 11 }), foregroundStyle(tint)]}>T3</Text>
    ),
    compactTrailing: (
      <Text modifiers={[font({ weight: "semibold", size: 11 }), foregroundStyle(tint)]}>
        {activeLabel}
      </Text>
    ),
    minimal: (
      <Text modifiers={[font({ weight: "bold", size: 11 }), foregroundStyle(tint)]}>T3</Text>
    ),
    expandedLeading: (
      <VStack modifiers={[padding({ all: 8 })]}>
        <Text modifiers={[font({ weight: "bold", size: 12 }), foregroundStyle(tint)]}>
          {activeLabel}
        </Text>
      </VStack>
    ),
    expandedCenter: row0 ? (
      <VStack>
        <Text
          modifiers={[font({ weight: "bold", size: 12 }), foregroundStyle("#ffffff"), lineLimit(1)]}
        >
          {row0.threadTitle}
        </Text>
        <Text modifiers={[font({ size: 11 }), foregroundStyle("#cbd5e1"), lineLimit(1)]}>
          {row0.projectTitle} - {row0.status}
        </Text>
      </VStack>
    ) : null,
    expandedTrailing: (
      <Text modifiers={[font({ size: 11 }), foregroundStyle("#cbd5e1")]}>Updated {updatedAt}</Text>
    ),
    expandedBottom: (
      <VStack modifiers={[padding({ all: 8 })]}>
        {row0 ? (
          <HStack modifiers={[padding({ vertical: 4 })]}>
            <VStack>
              <Text
                modifiers={[
                  font({ weight: "bold", size: 13 }),
                  foregroundStyle("#ffffff"),
                  lineLimit(1),
                ]}
              >
                {row0.threadTitle}
              </Text>
              <Text modifiers={[font({ size: 11 }), foregroundStyle("#cbd5e1"), lineLimit(1)]}>
                {row0.projectTitle} - {row0.modelTitle}
              </Text>
            </VStack>
            <Spacer minLength={8} />
            <Text modifiers={[font({ weight: "semibold", size: 11 }), foregroundStyle(tint)]}>
              {row0.status}
            </Text>
          </HStack>
        ) : null}
        {row1 ? (
          <HStack modifiers={[padding({ vertical: 4 })]}>
            <VStack>
              <Text
                modifiers={[
                  font({ weight: "bold", size: 13 }),
                  foregroundStyle("#ffffff"),
                  lineLimit(1),
                ]}
              >
                {row1.threadTitle}
              </Text>
              <Text modifiers={[font({ size: 11 }), foregroundStyle("#cbd5e1"), lineLimit(1)]}>
                {row1.projectTitle} - {row1.modelTitle}
              </Text>
            </VStack>
            <Spacer minLength={8} />
            <Text modifiers={[font({ weight: "semibold", size: 11 }), foregroundStyle(tint)]}>
              {row1.status}
            </Text>
          </HStack>
        ) : null}
        {row2 ? (
          <HStack modifiers={[padding({ vertical: 4 })]}>
            <VStack>
              <Text
                modifiers={[
                  font({ weight: "bold", size: 13 }),
                  foregroundStyle("#ffffff"),
                  lineLimit(1),
                ]}
              >
                {row2.threadTitle}
              </Text>
              <Text modifiers={[font({ size: 11 }), foregroundStyle("#cbd5e1"), lineLimit(1)]}>
                {row2.projectTitle} - {row2.modelTitle}
              </Text>
            </VStack>
            <Spacer minLength={8} />
            <Text modifiers={[font({ weight: "semibold", size: 11 }), foregroundStyle(tint)]}>
              {row2.status}
            </Text>
          </HStack>
        ) : null}
      </VStack>
    ),
  };
}

export default createLiveActivity<AgentActivityProps>("AgentActivity", AgentActivity);
