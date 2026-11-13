/**
 * Thread feed markdown rendering and artifact template cards.
 */
import { Button } from "../../../components/ui/Button";
import {
  enrichedContextLinkCustomization,
  enrichedThreadLinkCustomization,
  withChipIcon,
} from "../../../native/useEnrichedLinkVariants";
import * as Haptics from "expo-haptics";
import {
  AuthFilesystemReadScope,
  idleCompactionOf,
  type OrchestrationMessageContext,
  ThreadId,
  type ChatAttachment,
  type ChatFileAttachment,
  type ChatImageAttachment,
  type EnvironmentId,
  type MessageId,
  type OrchestrationV2ProjectedTurnItem,
  type RunId,
  type ScheduledTaskId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  codexArtifactTemplatePresentationLabel,
  type CodexArtifactTemplate,
} from "@t3tools/shared/codexArtifactTemplates";
import {
  renderCodexInlineDirectivesAsMarkdown,
  splitCodexArtifactTemplateMarkdown,
} from "@t3tools/shared/codexMarkdownDirectives";
import { SymbolView, type AppSymbolName } from "../../../components/ui/AppSymbol";
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  useId,
  type ComponentPropsWithRef,
  type ComponentRef,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import {
  Image,
  Platform,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  StyleSheet,
  type ColorValue,
  useWindowDimensions,
  View,
} from "react-native";
import { flattenThemeColor } from "../../../lib/mobileTheme";
import { useUniwindTheme } from "../../../lib/useUniwindTheme";
import { FONT_FAMILIES } from "../../../lib/fontFamilies";
import { splitMarkdownDetails } from "../../../lib/markdownDetails";
import {
  SelectableMarkdownText,
  type MarkdownFileContextMenu,
  type MarkdownImageRenderer,
  type MarkdownImageSourceResolver,
  type MarkdownLinkCustomization,
  type NativeMarkdownTextStyle,
  type SelectableMarkdownSkill,
} from "../../../native/SelectableMarkdownText";
import { AppText as Text } from "../../../components/ui/AppText";
import { resolveNativeMarkdownTypography } from "../../../lib/appearancePreferences";
import { useAppearancePreferences } from "../../settings/appearance/AppearancePreferencesProvider";
import {
  collapsedWorkLogHeight,
  ThreadDisclosureChevron,
  THREAD_DISCLOSURE_TRANSITION_MS,
  ThreadWorkGroupToggle,
  ThreadThinkingRow,
  ThreadWorkLog,
  WORK_GROUP_TOGGLE_HEIGHT,
} from "../thread-work-log";
import {
  resolveThreadLink,
  useLiveThreadLinkLabels,
  useQuietThreadShell,
  useThreadChipIcons,
} from "../../../state/entities";

export const WIDE_MARKDOWN_BLOCK_OPTIONS = {
  // iOS blockquotes and selectable text measure separately; definite bubble width matches UIKit's drawing width.
  includeBlockquotes: Platform.OS === "ios",
  includeOrderedLists: Platform.OS === "android",
} as const;

export interface MarkdownLinkHandlers {
  readonly onLinkPress: (href: string) => void;
  readonly fileContextMenu: (href: string) => MarkdownFileContextMenu | undefined;
  readonly onFileContextMenuAction: (href: string, actionId: string) => void;
  readonly onImagePress?: (href: string) => void;
  readonly resolveImageSource?: MarkdownImageSourceResolver;
  readonly fileEmbedLabel?: (href: string, standalone: boolean) => string | null;
  readonly linkCustomization?: (href: string) => MarkdownLinkCustomization | undefined;
}

export interface MarkdownStyleSets {
  readonly user: MarkdownStyleSet;
  readonly assistant: MarkdownStyleSet;
}

export interface MarkdownStyleSet {
  readonly nativeTextStyle: NativeMarkdownTextStyle;
}

export const ARTIFACT_TEMPLATE_SYMBOL_BY_KIND: Record<
  CodexArtifactTemplate["artifactKind"],
  AppSymbolName
> = {
  document: "doc.text",
  presentation: "chart.bar.xaxis",
  spreadsheet: "chart.bar.xaxis",
  site: "safari",
  "google-docs": "doc.text",
  "google-slides": "chart.bar.xaxis",
  "google-sheets": "chart.bar.xaxis",
  image: "camera",
  email: "text.bubble",
  slack: "text.bubble",
};

export function ArtifactTemplateCard(props: {
  readonly template: CodexArtifactTemplate;
  readonly onUse?: ((template: CodexArtifactTemplate) => void) | undefined;
}) {
  return (
    <View className="my-2 min-w-0 flex-row items-center gap-3 rounded-2xl border border-border bg-card px-3 py-3">
      <View className="relative h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-subtle">
        <SymbolView
          name={ARTIFACT_TEMPLATE_SYMBOL_BY_KIND[props.template.artifactKind]}
          size={20}
          tintColorClassName="accent-foreground-muted"
          type="monochrome"
        />
        <View className="absolute -right-1 -bottom-1 h-4 w-4 items-center justify-center rounded-full bg-fuchsia-500">
          <SymbolView
            name={{ ios: "sparkles", android: "auto_awesome" }}
            size={9}
            tintColor="white"
            type="monochrome"
          />
        </View>
      </View>
      <View className="min-w-0 flex-1">
        <Text className="font-t3-bold text-sm text-foreground" numberOfLines={1}>
          {props.template.displayName}
        </Text>
        <Text className="text-xs text-foreground-muted">
          {codexArtifactTemplatePresentationLabel(props.template.artifactKind)}
        </Text>
      </View>
      {props.onUse ? (
        <Button
          label="Use template"
          tone="secondary"
          accessibilityLabel={`Use ${props.template.displayName} template`}
          onPress={() => props.onUse?.(props.template)}
        />
      ) : null}
    </View>
  );
}

export const AssistantMarkdownContent = memo(function AssistantMarkdownContent(props: {
  readonly markdown: string;
  readonly environmentId: EnvironmentId;
  readonly markdownStyles: MarkdownStyleSet;
  readonly linkHandlers: MarkdownLinkHandlers;
  readonly onUseArtifactTemplate?: ((template: CodexArtifactTemplate) => void) | undefined;
  readonly renderImage: MarkdownImageRenderer;
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill> | undefined;
}) {
  const liveMarkdown = useLiveThreadLinkLabels(props.markdown, props.environmentId);
  const threadIcons = useThreadChipIcons(props.environmentId, liveMarkdown);
  const linkHandlers: MarkdownLinkHandlers = {
    ...props.linkHandlers,
    linkCustomization: (href) =>
      withChipIcon(props.linkHandlers.linkCustomization?.(href), threadIcons.get(href)),
  };

  return (
    <AssistantMarkdownBlocks
      markdown={liveMarkdown}
      markdownStyles={props.markdownStyles}
      linkHandlers={linkHandlers}
      onUseArtifactTemplate={props.onUseArtifactTemplate}
      renderImage={props.renderImage}
      skills={props.skills}
    />
  );
});

// Folds split first, so an artifact card inside a fold stays inside it.

export function AssistantMarkdownBlocks(props: {
  readonly markdown: string;
  readonly markdownStyles: MarkdownStyleSet;
  readonly linkHandlers: MarkdownLinkHandlers;
  readonly onUseArtifactTemplate?: ((template: CodexArtifactTemplate) => void) | undefined;
  readonly renderImage: MarkdownImageRenderer;
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill> | undefined;
}) {
  const blocks = useMemo(
    () =>
      splitMarkdownDetails(props.markdown).map((block) =>
        block.kind === "details"
          ? block
          : { ...block, segments: splitCodexArtifactTemplateMarkdown(block.markdown) },
      ),
    [props.markdown],
  );
  return blocks.map((block) => {
    if (block.kind === "details") {
      return (
        <MarkdownDetailsFold
          key={`details:${block.sourceOffset}`}
          summary={block.summary}
          initiallyOpen={block.open}
        >
          <AssistantMarkdownBlocks {...props} markdown={block.body} />
        </MarkdownDetailsFold>
      );
    }
    return block.segments.map((segment) => {
      const offset = block.sourceOffset + segment.sourceOffset;
      if (segment.kind === "artifact-template") {
        return (
          <ArtifactTemplateCard
            key={`artifact-template:${offset}`}
            template={segment.template}
            onUse={props.onUseArtifactTemplate}
          />
        );
      }
      if (segment.markdown.trim().length === 0) return null;
      return (
        <SelectableMarkdownText
          key={`markdown:${offset}`}
          markdown={renderCodexInlineDirectivesAsMarkdown(segment.markdown)}
          skills={props.skills}
          textStyle={props.markdownStyles.nativeTextStyle}
          {...props.linkHandlers}
          renderImage={props.renderImage}
        />
      );
    });
  });
}

export function MarkdownDetailsFold(props: {
  readonly summary: string;
  readonly initiallyOpen: boolean;
  readonly children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(props.initiallyOpen);
  const iconSubtleColor = useUniwindTheme()["--color-icon-subtle"];
  return (
    <View className="my-2 border-y border-border">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.summary}
        accessibilityState={{ expanded }}
        hitSlop={4}
        className="min-h-10 flex-row items-center gap-2 py-2"
        onPress={() => {
          void Haptics.selectionAsync();
          setExpanded((value) => !value);
        }}
      >
        <ThreadDisclosureChevron
          expanded={expanded}
          collapsedDirection="right"
          size={12}
          tintColor={iconSubtleColor}
        />
        <Text className="min-w-0 shrink font-t3-medium text-sm text-foreground">
          {props.summary}
        </Text>
      </Pressable>
      {expanded ? <View className="pb-3 pl-5">{props.children}</View> : null}
    </View>
  );
}

export function useMarkdownStyles(): MarkdownStyleSets {
  const { appearance } = useAppearancePreferences();
  const nativeMarkdownTypography = resolveNativeMarkdownTypography(appearance.baseFontSize);
  const theme = useUniwindTheme();
  const markdownBodyColor = theme["--color-md-body"];
  const markdownStrongColor = theme["--color-md-strong"];
  const markdownLinkColor = theme["--color-md-link"];
  const markdownBlockquoteBorder = theme["--color-md-blockquote-border"];
  const markdownCodeBg = theme["--color-md-code-bg"];
  const markdownCodeText = theme["--color-md-code-text"];
  const markdownInlineCodeText = theme["--color-foreground-secondary"];
  const markdownHrColor = theme["--color-md-hr"];
  // Native chip drawing parses opaque hex only, and this role is translucent.
  const contextChipBorderColor = flattenThemeColor(
    theme["--color-border"],
    theme["--color-user-bubble"],
  );
  const markdownUserBodyColor = theme["--color-user-bubble-foreground"];
  const markdownUserCodeBg = theme["--color-md-user-code-bg"];
  const markdownUserCodeText = theme["--color-md-user-code-text"];
  const markdownUserInlineCodeText = theme["--color-user-bubble-foreground-muted"];
  const markdownUserFenceBg = theme["--color-md-user-fence-bg"];
  const regularFontFamily = FONT_FAMILIES.regular;
  const boldFontFamily = FONT_FAMILIES.bold;

  return {
    user: {
      nativeTextStyle: {
        color: markdownUserBodyColor,
        strongColor: markdownUserBodyColor,
        mutedColor: markdownUserBodyColor,
        linkColor: markdownUserBodyColor,
        inlineCodeColor: markdownUserInlineCodeText,
        codeColor: markdownUserCodeText,
        codeBackgroundColor: markdownUserCodeBg,
        codeBlockBackgroundColor: markdownUserFenceBg,
        fileTextColor: markdownUserBodyColor,
        quoteMarkerColor: markdownUserBodyColor,
        dividerColor: markdownUserBodyColor,
        contextChipBorderColor,
        fontSize: nativeMarkdownTypography.fontSize,
        lineHeight: nativeMarkdownTypography.lineHeight,
        headingFontSizes: nativeMarkdownTypography.headingFontSizes,
        fontFamily: regularFontFamily,
        headingFontFamily: boldFontFamily,
        boldFontFamily,
      },
    },
    assistant: {
      nativeTextStyle: {
        color: markdownBodyColor,
        strongColor: markdownStrongColor,
        mutedColor: markdownBodyColor,
        linkColor: markdownLinkColor,
        inlineCodeColor: markdownInlineCodeText,
        codeColor: markdownCodeText,
        codeBackgroundColor: markdownCodeBg,
        codeBlockBackgroundColor: markdownCodeBg,
        fileTextColor: markdownCodeText,
        quoteMarkerColor: markdownBlockquoteBorder,
        dividerColor: markdownHrColor,
        contextChipBorderColor,
        fontSize: nativeMarkdownTypography.fontSize,
        lineHeight: nativeMarkdownTypography.lineHeight,
        headingFontSizes: nativeMarkdownTypography.headingFontSizes,
        fontFamily: regularFontFamily,
        headingFontFamily: boldFontFamily,
        boldFontFamily,
      },
    },
  };
}

/** Messages from other agents fold to one line so the user's own messages stay easy to find. */
