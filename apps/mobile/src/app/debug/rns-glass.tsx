import { Stack } from "expo-router";
import { useEffect, useRef, useState, type ComponentProps } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useColorScheme,
  useWindowDimensions,
  View,
  type NativeSyntheticEvent,
  type ScrollView as ScrollViewType,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Screen,
  ScreenStack,
  ScreenStackHeaderConfig,
  ScreenStackHeaderSearchBarView,
  SearchBar,
} from "react-native-screens";

const CODE_LINES = [
  "# Native RNS glass debug route",
  "",
  "This screen intentionally avoids Expo Router headers.",
  "The native header below is owned by react-native-screens.",
  "",
  "Expected iOS 26 behavior:",
  "- At rest: header should feel like app background",
  "- While scrolled: content should blur behind the header",
  "- No gray custom overlay",
  "- No JS blur view",
  "",
  "Scroll edge effect should sample actual content:",
  "const header = { translucent: true }",
  "const scrollEdgeEffects = { top: 'soft' }",
  "",
  "Bright rows below make sampling failures obvious.",
  "",
  "node_modules",
  "/.pnp",
  ".pnp.*",
  ".yarn/*",
  "!.yarn/patches",
  "!.yarn/plugins",
  "!.yarn/releases",
  "!.yarn/versions",
  "",
  "# testing",
  "/coverage",
  ".convex",
  "e2e/.local-dev.json",
  "e2e/playwright-report",
  "e2e/test-results",
  "",
  "# app surfaces",
  "threads",
  "terminal",
  "diff renderer",
  "file explorer",
  "composer",
  "native header",
  "scroll edge",
  "liquid glass",
];

const SWATCHES = ["#0A84FF", "#30D158", "#FF9F0A", "#BF5AF2", "#64D2FF", "#FF375F"];

const CODE_ROWS = CODE_LINES.concat(CODE_LINES).map((line, index) => ({
  id: `debug-code-line-${index}`,
  line,
}));

const THREADS = [
  {
    id: "markdown",
    initials: "MD",
    title: "Markdown rendering test",
    subtitle: "Renderer stress test, native header, and glass sampling",
    time: "14h",
    color: "#0A84FF",
  },
  {
    id: "ipad",
    initials: "IP",
    title: "iPad rectly text correction",
    subtitle: "Split layout, sidebar search, keyboard and trackpad scroll",
    time: "16h",
    color: "#BF5AF2",
  },
  {
    id: "webview",
    initials: "WV",
    title: "Preview Webview Persists Off Panel",
    subtitle: "Browser surface, native columns, and panel ownership",
    time: "22m",
    color: "#30D158",
  },
  {
    id: "diff",
    initials: "DF",
    title: "Diff renderer pass",
    subtitle: "Review comments and code highlighting in wide layouts",
    time: "2d",
    color: "#FF9F0A",
  },
  {
    id: "terminal",
    initials: "TY",
    title: "Terminal pty keyboard routing",
    subtitle: "Tab key, focus behavior, and hardware keyboard shortcuts",
    time: "3d",
    color: "#FF375F",
  },
  {
    id: "files",
    initials: "FX",
    title: "File explorer polish",
    subtitle: "Sidebar disclosure, previews, and trackpad scrolling",
    time: "4d",
    color: "#64D2FF",
  },
] as const;

type ThreadId = (typeof THREADS)[number]["id"];

const SIDEBAR_THREADS = THREADS.flatMap((thread) => [
  { ...thread, rowId: `${thread.id}-primary`, selectedCandidate: true },
  { ...thread, rowId: `${thread.id}-repeat`, selectedCandidate: false },
]);

interface DebugColors {
  readonly background: string;
  readonly card: string;
  readonly foreground: string;
  readonly secondary: string;
  readonly separator: string;
}

export default function RnsGlassDebugRoute() {
  const colorScheme = useColorScheme();
  const isDark = colorScheme !== "light";
  const { width } = useWindowDimensions();
  const scrollRef = useRef<ScrollViewType | null>(null);
  const sidebarScrollRef = useRef<ScrollViewType | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedThreadId, setSelectedThreadId] = useState<ThreadId>("markdown");
  const usesWideSplit = Platform.OS === "ios" && width >= 700;

  useEffect(() => {
    const stops = [0, 0, 190, 190, 0, 360, 80, 0] as const;
    let index = 0;

    const reset = () => {
      scrollRef.current?.scrollTo({
        animated: false,
        y: 0,
      });
      sidebarScrollRef.current?.scrollTo({
        animated: false,
        y: 0,
      });
    };

    reset();
    const postLayoutReset = setTimeout(reset, 250);

    const tick = () => {
      scrollRef.current?.scrollTo({
        animated: true,
        y: stops[index % stops.length],
      });
      sidebarScrollRef.current?.scrollTo({
        animated: true,
        y: index % 2 === 0 ? 0 : 150,
      });
      index += 1;
    };

    const initial = setTimeout(tick, 4200);
    const interval = setInterval(tick, 4200);

    return () => {
      clearTimeout(initial);
      clearTimeout(postLayoutReset);
      clearInterval(interval);
    };
  }, []);

  const foreground = isDark ? "#F5F5F7" : "#111114";
  const secondary = isDark ? "rgba(245,245,247,0.62)" : "rgba(17,17,20,0.58)";
  const background = isDark ? "#050507" : "#F4F4F7";
  const card = isDark ? "#10131B" : "#FFFFFF";
  const separator = isDark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.12)";
  const colors = { background, card, foreground, secondary, separator };

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.host, { backgroundColor: background }]}>
        {usesWideSplit ? (
          <MailWideSplitDemo
            colors={colors}
            detailScrollRef={scrollRef}
            searchQuery={searchQuery}
            selectedThreadId={selectedThreadId}
            sidebarScrollRef={sidebarScrollRef}
            onSearchQueryChange={setSearchQuery}
            onSelectThread={setSelectedThreadId}
          />
        ) : (
          <SidebarColumn
            compact
            colors={colors}
            searchQuery={searchQuery}
            scrollRef={sidebarScrollRef}
            selectedThreadId={selectedThreadId}
            onSearchQueryChange={setSearchQuery}
            onSelectThread={setSelectedThreadId}
          />
        )}
      </View>
    </>
  );
}

function SidebarColumn(props: {
  readonly compact: boolean;
  readonly colors: DebugColors;
  readonly onSelectThread: (threadId: ThreadId) => void;
  readonly onSearchQueryChange: (query: string) => void;
  readonly searchQuery: string;
  readonly scrollRef: React.RefObject<ScrollViewType | null>;
  readonly selectedThreadId: ThreadId;
}) {
  const { colors } = props;
  const insets = useSafeAreaInsets();
  const compactTopInset = 18;
  const headerButtonTint = colors.foreground;

  if (props.compact) {
    return (
      <ScreenStack style={styles.stack}>
        <Screen
          activityState={2}
          enabled
          hasLargeHeader={false}
          isNativeStack
          screenId="rns-glass-mail-phone"
          scrollEdgeEffects={{
            bottom: "automatic",
            left: "hidden",
            right: "hidden",
            top: "automatic",
          }}
          style={[styles.screen, { backgroundColor: colors.background }]}
        >
          <ScrollView
            ref={props.scrollRef}
            automaticallyAdjustContentInsets
            contentInsetAdjustmentBehavior="automatic"
            contentContainerStyle={[
              styles.sidebarContent,
              styles.compactListContent,
              { paddingTop: compactTopInset },
            ]}
            scrollIndicatorInsets={{
              bottom: insets.bottom + 92,
              top: insets.top + 96,
            }}
            style={styles.scrollView}
          >
            <SidebarThreadRows {...props} highlightsSelection={false} />
          </ScrollView>
          <ScreenStackHeaderConfig
            backgroundColor="rgba(0,0,0,0)"
            color={colors.foreground}
            headerRightBarButtonItems={
              [
                {
                  accessibilityLabel: "More",
                  icon: { name: "ellipsis", type: "sfSymbol" },
                  identifier: "rns-glass-more",
                  onPress: () => {},
                  tintColor: headerButtonTint,
                  type: "button",
                  variant: "prominent",
                },
              ] as ComponentProps<typeof ScreenStackHeaderConfig>["headerRightBarButtonItems"]
            }
            headerToolbarItems={
              [
                {
                  composeButtonId: "rns-glass-compose",
                  composeSystemImageName: "square.and.pencil",
                  filterButtonId: "rns-glass-filter",
                  filterSystemImageName: "line.3.horizontal.decrease",
                  onSearchTextChange: props.onSearchQueryChange,
                  placeholder: "Search",
                  searchTextChangeId: "rns-glass-search-text",
                  type: "mailSearchToolbar",
                  useFallbackSearchField: true,
                },
              ] as ComponentProps<typeof ScreenStackHeaderConfig>["headerToolbarItems"]
            }
            hideBackButton
            hideShadow={false}
            largeTitle={false}
            navigationItemStyle="editor"
            subtitle="t3code · Ready"
            title="Threads"
            titleColor={colors.foreground}
            titleFontSize={18}
            titleFontWeight="800"
            translucent
          ></ScreenStackHeaderConfig>
        </Screen>
      </ScreenStack>
    );
  }

  return (
    <ScreenStack style={styles.stack}>
      <Screen
        activityState={2}
        enabled
        hasLargeHeader={false}
        isNativeStack
        screenId={props.compact ? "rns-glass-mail-list" : "rns-glass-sidebar"}
        scrollEdgeEffects={{
          bottom: "hidden",
          left: "hidden",
          right: "hidden",
          top: "automatic",
        }}
        style={[styles.screen, { backgroundColor: colors.background }]}
      >
        <ScrollView
          ref={props.scrollRef}
          automaticallyAdjustContentInsets
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={styles.sidebarContent}
          scrollIndicatorInsets={{ bottom: 24, top: 96 }}
          style={styles.scrollView}
        >
          <SidebarThreadRows {...props} />
        </ScrollView>
        {props.compact ? null : (
          <ScreenStackHeaderConfig
            backgroundColor="rgba(0,0,0,0)"
            color={colors.foreground}
            headerToolbarItems={undefined}
            hideBackButton
            hideShadow={false}
            largeTitle={false}
            largeTitleBackgroundColor="rgba(0,0,0,0)"
            largeTitleColor={colors.foreground}
            navigationItemStyle="editor"
            title="Threads"
            titleColor={colors.foreground}
            titleFontSize={17}
            titleFontWeight="700"
            translucent
          >
            <ScreenStackHeaderSearchBarView>
              <SearchBar
                allowToolbarIntegration={false}
                barTintColor={colors.background}
                hideNavigationBar={false}
                hideWhenScrolling={false}
                obscureBackground={false}
                placement="integrated"
                placeholder="Search"
                textColor={colors.foreground}
                tintColor={colors.foreground}
              />
            </ScreenStackHeaderSearchBarView>
          </ScreenStackHeaderConfig>
        )}
      </Screen>
    </ScreenStack>
  );
}

function MailWideSplitDemo(props: {
  readonly colors: DebugColors;
  readonly detailScrollRef: React.RefObject<ScrollViewType | null>;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onSelectThread: (threadId: ThreadId) => void;
  readonly searchQuery: string;
  readonly selectedThreadId: ThreadId;
  readonly sidebarScrollRef: React.RefObject<ScrollViewType | null>;
}) {
  const { colors } = props;

  return (
    <View style={styles.wideSplit}>
      <View
        style={[
          styles.wideSidebarPane,
          { backgroundColor: colors.background, borderRightColor: colors.separator },
        ]}
      >
        <MailWideSidebarNativePane
          colors={colors}
          searchQuery={props.searchQuery}
          scrollRef={props.sidebarScrollRef}
          selectedThreadId={props.selectedThreadId}
          onSearchQueryChange={props.onSearchQueryChange}
          onSelectThread={props.onSelectThread}
        />
      </View>
      <View style={[styles.detailPane, { backgroundColor: colors.background }]}>
        <MailWideDetailNativePane
          colors={colors}
          scrollRef={props.detailScrollRef}
          onSearchQueryChange={props.onSearchQueryChange}
        />
      </View>
    </View>
  );
}

function MailWideSidebarNativePane(props: {
  readonly colors: DebugColors;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onSelectThread: (threadId: ThreadId) => void;
  readonly searchQuery: string;
  readonly scrollRef: React.RefObject<ScrollViewType | null>;
  readonly selectedThreadId: ThreadId;
}) {
  const { colors } = props;
  const insets = useSafeAreaInsets();
  const headerInset = insets.top + 76;
  const headerButtonTint = colors.foreground;

  return (
    <ScreenStack style={styles.stack}>
      <Screen
        activityState={2}
        enabled
        hasLargeHeader={false}
        isNativeStack
        screenId="rns-glass-mail-ipad-sidebar"
        scrollEdgeEffects={{
          bottom: "hidden",
          left: "hidden",
          right: "hidden",
          top: "automatic",
        }}
        style={[styles.screen, { backgroundColor: colors.background }]}
      >
        <ScrollView
          ref={props.scrollRef}
          automaticallyAdjustContentInsets
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={[
            styles.sidebarContent,
            styles.wideSidebarContent,
            { paddingTop: headerInset },
          ]}
          scrollIndicatorInsets={{ bottom: 24, top: 84 }}
          style={styles.scrollView}
        >
          <SidebarThreadRows
            compact
            colors={colors}
            searchQuery={props.searchQuery}
            selectedThreadId={props.selectedThreadId}
            onSelectThread={props.onSelectThread}
          />
        </ScrollView>
        <ScreenStackHeaderConfig
          backgroundColor="rgba(0,0,0,0)"
          color={colors.foreground}
          headerRightBarButtonItems={
            [
              {
                accessibilityLabel: "Filter threads",
                icon: { name: "line.3.horizontal.decrease", type: "sfSymbol" },
                identifier: "rns-glass-ipad-filter",
                onPress: () => {},
                sharesBackground: true,
                tintColor: headerButtonTint,
                type: "button",
                variant: "prominent",
              },
              {
                accessibilityLabel: "Open settings",
                icon: { name: "gearshape", type: "sfSymbol" },
                identifier: "rns-glass-ipad-settings",
                onPress: () => {},
                sharesBackground: true,
                tintColor: headerButtonTint,
                type: "button",
                variant: "prominent",
              },
            ] as ComponentProps<typeof ScreenStackHeaderConfig>["headerRightBarButtonItems"]
          }
          hideBackButton
          hideShadow={false}
          largeTitle={false}
          navigationItemStyle="editor"
          subtitle="t3code · Ready"
          title="Threads"
          titleColor={colors.foreground}
          titleFontSize={17}
          titleFontWeight="800"
          translucent
        />
      </Screen>
    </ScreenStack>
  );
}

function MailWideDetailNativePane(props: {
  readonly colors: DebugColors;
  readonly onSearchQueryChange: (query: string) => void;
  readonly scrollRef: React.RefObject<ScrollViewType | null>;
}) {
  const { colors } = props;
  const insets = useSafeAreaInsets();
  const headerInset = insets.top + 88;
  const headerButtonTint = colors.foreground;

  return (
    <ScreenStack style={styles.stack}>
      <Screen
        activityState={2}
        enabled
        hasLargeHeader={false}
        isNativeStack
        screenId="rns-glass-mail-ipad-detail"
        scrollEdgeEffects={{
          bottom: "hidden",
          left: "hidden",
          right: "hidden",
          top: "automatic",
        }}
        style={[styles.screen, { backgroundColor: colors.background }]}
      >
        <ScrollView
          ref={props.scrollRef}
          automaticallyAdjustContentInsets
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={[styles.scrollContent, { paddingTop: headerInset }]}
          scrollIndicatorInsets={{ bottom: 24, top: 92 }}
          style={styles.scrollView}
        >
          <View style={styles.detailMessageBubble}>
            <Text style={styles.detailMessageText}>
              Yoooo respond with a bunch of markdown so i can test rendering stuff. Do some tool
              calls first to research the project a bit, then respond with a long markdown text
            </Text>
          </View>
          <View style={styles.swatchRow}>
            {SWATCHES.map((color, index) => (
              <View key={color} style={[styles.swatch, { backgroundColor: color }]}>
                <Text style={styles.swatchText}>{index + 1}</Text>
              </View>
            ))}
          </View>
          <View
            style={[styles.card, { backgroundColor: colors.card, borderColor: colors.separator }]}
          >
            <Text style={[styles.cardTitle, { color: colors.foreground }]}>
              T3 Code Renderer Stress Test
            </Text>
            <Text style={[styles.body, { color: colors.secondary }]}>
              This wide spike maps T3 Code surfaces onto the Mail iPad header structure: sidebar
              controls stay with the list, thread controls stay with the detail pane, and the
              content keeps scrolling underneath the glass.
            </Text>
          </View>
          <View
            style={[
              styles.codeCard,
              { backgroundColor: colors.card, borderColor: colors.separator },
            ]}
          >
            {CODE_ROWS.map(({ id, line }, index) => (
              <View key={id} style={styles.codeLine}>
                <Text style={[styles.lineNumber, { color: colors.secondary }]}>{index + 1}</Text>
                <Text style={[styles.codeText, { color: colors.foreground }]}>{line || " "}</Text>
              </View>
            ))}
          </View>
        </ScrollView>
        <ScreenStackHeaderConfig
          backgroundColor="rgba(0,0,0,0)"
          color={colors.foreground}
          headerLeftBarButtonItems={
            [
              {
                accessibilityLabel: "Open git",
                icon: { name: "point.3.connected.trianglepath.dotted", type: "sfSymbol" },
                identifier: "rns-glass-ipad-git",
                onPress: () => {},
                sharesBackground: true,
                tintColor: headerButtonTint,
                type: "button",
                variant: "prominent",
              },
              {
                accessibilityLabel: "Open files",
                icon: { name: "folder", type: "sfSymbol" },
                identifier: "rns-glass-ipad-files",
                onPress: () => {},
                sharesBackground: true,
                tintColor: headerButtonTint,
                type: "button",
                variant: "prominent",
              },
              {
                accessibilityLabel: "Open terminal",
                icon: { name: "terminal", type: "sfSymbol" },
                identifier: "rns-glass-ipad-terminal",
                onPress: () => {},
                sharesBackground: true,
                tintColor: headerButtonTint,
                type: "button",
                variant: "prominent",
              },
              {
                accessibilityLabel: "New chat",
                icon: { name: "square.and.pencil", type: "sfSymbol" },
                identifier: "rns-glass-ipad-compose",
                onPress: () => {},
                sharesBackground: true,
                tintColor: headerButtonTint,
                type: "button",
                variant: "prominent",
              },
              {
                accessibilityLabel: "Expand detail",
                icon: { name: "arrow.up.left.and.arrow.down.right", type: "sfSymbol" },
                identifier: "rns-glass-ipad-expand",
                onPress: () => {},
                sharesBackground: true,
                tintColor: headerButtonTint,
                type: "button",
                variant: "prominent",
              },
            ] as ComponentProps<typeof ScreenStackHeaderConfig>["headerLeftBarButtonItems"]
          }
          hideBackButton
          hideShadow={false}
          largeTitle={false}
          navigationItemStyle="editor"
          subtitle="t3code · Julius’s Mac mini"
          title="Markdown rendering test"
          titleColor={colors.foreground}
          titleFontSize={17}
          titleFontWeight="800"
          translucent
        >
          <ScreenStackHeaderSearchBarView>
            <SearchBar
              allowToolbarIntegration
              autoCapitalize="none"
              barTintColor={colors.background}
              hideNavigationBar={false}
              hideWhenScrolling={false}
              obscureBackground={false}
              onChangeText={(event: NativeSyntheticEvent<{ readonly text?: string }>) => {
                props.onSearchQueryChange(event.nativeEvent.text ?? "");
              }}
              placement="integratedButton"
              placeholder="Search"
              textColor={colors.foreground}
              tintColor={colors.foreground}
            />
          </ScreenStackHeaderSearchBarView>
        </ScreenStackHeaderConfig>
      </Screen>
    </ScreenStack>
  );
}

function SidebarThreadRows(props: {
  readonly compact: boolean;
  readonly colors: DebugColors;
  readonly highlightsSelection?: boolean;
  readonly onSelectThread: (threadId: ThreadId) => void;
  readonly searchQuery?: string;
  readonly selectedThreadId: ThreadId;
}) {
  const { colors } = props;
  const normalizedQuery = props.searchQuery?.trim().toLocaleLowerCase() ?? "";
  const threads =
    normalizedQuery.length === 0
      ? SIDEBAR_THREADS
      : SIDEBAR_THREADS.filter((thread) =>
          `${thread.title} ${thread.subtitle}`.toLocaleLowerCase().includes(normalizedQuery),
        );

  return (
    <>
      <Text style={[styles.sidebarSection, { color: colors.secondary }]}>t3code</Text>
      {threads.map((thread) => {
        const selected =
          props.highlightsSelection !== false &&
          thread.id === props.selectedThreadId &&
          thread.selectedCandidate;
        return (
          <Pressable
            key={thread.rowId}
            accessibilityRole="button"
            onPress={() => props.onSelectThread(thread.id)}
            style={[
              props.compact ? styles.mailThreadRow : styles.threadRow,
              selected
                ? { backgroundColor: props.compact ? "#0A84FF" : colors.card }
                : { backgroundColor: "rgba(255,255,255,0)" },
            ]}
          >
            <View
              style={[
                styles.avatar,
                {
                  backgroundColor:
                    selected && props.compact ? "rgba(255,255,255,0.22)" : thread.color,
                },
              ]}
            >
              <Text style={styles.avatarText}>{thread.initials}</Text>
            </View>
            <View style={styles.threadCopy}>
              <View style={styles.threadTitleRow}>
                <Text
                  numberOfLines={1}
                  style={[
                    props.compact ? styles.mailThreadTitle : styles.threadTitle,
                    { color: selected && props.compact ? "white" : colors.foreground },
                  ]}
                >
                  {thread.title}
                </Text>
                <Text
                  style={[
                    props.compact ? styles.mailThreadTime : styles.threadTime,
                    {
                      color: selected && props.compact ? "rgba(255,255,255,0.8)" : colors.secondary,
                    },
                  ]}
                >
                  {thread.time}
                </Text>
              </View>
              <Text
                numberOfLines={2}
                style={[
                  props.compact ? styles.mailThreadSubtitle : styles.threadSubtitle,
                  {
                    color: selected && props.compact ? "rgba(255,255,255,0.82)" : colors.secondary,
                  },
                ]}
              >
                {thread.subtitle}
              </Text>
            </View>
          </Pressable>
        );
      })}
    </>
  );
}

const styles = StyleSheet.create({
  avatar: {
    alignItems: "center",
    borderRadius: 32,
    height: 64,
    justifyContent: "center",
    width: 64,
  },
  avatarText: {
    color: "white",
    fontSize: 22,
    fontWeight: "800",
  },
  body: {
    fontSize: 17,
    lineHeight: 24,
  },
  card: {
    borderRadius: 28,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 10,
    marginHorizontal: 18,
    marginTop: 22,
    padding: 22,
  },
  cardTitle: {
    fontSize: 22,
    fontWeight: "700",
    letterSpacing: -0.4,
  },
  codeCard: {
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    marginHorizontal: 18,
    marginTop: 22,
    overflow: "hidden",
    paddingVertical: 14,
  },
  codeLine: {
    flexDirection: "row",
    gap: 16,
    minHeight: 28,
    paddingHorizontal: 16,
  },
  codeText: {
    flex: 1,
    fontFamily: Platform.select({ default: "Menlo", ios: "Menlo" }),
    fontSize: 16,
    lineHeight: 25,
  },
  compactListContent: {
    paddingBottom: 150,
    paddingHorizontal: 18,
  },
  glassIconButton: {
    alignItems: "center",
    justifyContent: "center",
  },
  glassIconGroup: {
    borderRadius: 28,
    flexDirection: "row",
    overflow: "hidden",
  },
  glassIconGroupItem: {
    alignItems: "center",
    justifyContent: "center",
  },
  hero: {
    gap: 10,
    paddingHorizontal: 18,
    paddingTop: 8,
  },
  host: {
    flex: 1,
  },
  kicker: {
    fontSize: 15,
    fontWeight: "700",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  lineNumber: {
    fontFamily: Platform.select({ default: "Menlo", ios: "Menlo" }),
    fontSize: 16,
    lineHeight: 25,
    textAlign: "right",
    width: 34,
  },
  detailMessageBubble: {
    alignSelf: "flex-end",
    backgroundColor: "#0A84FF",
    borderRadius: 28,
    marginHorizontal: 28,
    marginTop: 8,
    maxWidth: 720,
    paddingHorizontal: 24,
    paddingVertical: 16,
  },
  detailMessageText: {
    color: "white",
    fontSize: 20,
    lineHeight: 28,
  },
  mailThreadRow: {
    borderRadius: 24,
    flexDirection: "row",
    gap: 14,
    minHeight: 96,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  mailThreadSubtitle: {
    fontSize: 17,
    lineHeight: 22,
  },
  mailThreadTime: {
    fontSize: 17,
    lineHeight: 24,
  },
  mailThreadTitle: {
    flex: 1,
    fontSize: 20,
    fontWeight: "800",
    letterSpacing: -0.3,
    lineHeight: 25,
  },
  mailBottomChrome: {
    alignItems: "center",
    bottom: 0,
    elevation: 20,
    flexDirection: "row",
    gap: 12,
    left: 16,
    pointerEvents: "box-none",
    position: "absolute",
    right: 16,
    zIndex: 20,
  },
  mailNavTitle: {
    fontSize: 22,
    fontWeight: "800",
    letterSpacing: -0.5,
    lineHeight: 26,
  },
  mailNavSubtitle: {
    fontSize: 14,
    fontWeight: "600",
    lineHeight: 18,
  },
  mailSearchInput: {
    flex: 1,
    fontSize: 28,
    fontWeight: "600",
    height: 58,
    padding: 0,
  },
  mailSearchPill: {
    alignItems: "center",
    borderRadius: 32,
    flex: 1,
    flexDirection: "row",
    gap: 10,
    height: 64,
    paddingHorizontal: 20,
  },
  mailTitleBlock: {
    flex: 1,
    minWidth: 0,
  },
  mailTopActions: {
    flexDirection: "row",
    gap: 10,
  },
  mailTopChrome: {
    elevation: 20,
    left: 0,
    pointerEvents: "box-none",
    position: "absolute",
    right: 0,
    top: 0,
    zIndex: 20,
  },
  mailTopGlass: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderRadius: 0,
    flex: 1,
  },
  mailTopRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 16,
    height: 58,
    paddingHorizontal: 20,
  },
  screen: {
    flex: 1,
  },
  detailPane: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 80,
  },
  scrollView: {
    flex: 1,
  },
  sidebarContent: {
    paddingBottom: 60,
    paddingHorizontal: 14,
  },
  sidebarPane: {
    borderRightWidth: StyleSheet.hairlineWidth,
    width: 390,
  },
  wideDetailHeaderRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 18,
    height: 64,
    paddingHorizontal: 20,
  },
  wideDetailLeftActions: {
    flexDirection: "row",
    gap: 10,
  },
  wideDetailSpacer: {
    flex: 1,
    minWidth: 24,
  },
  wideSidebarContent: {
    paddingHorizontal: 18,
  },
  wideSidebarHeaderRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 14,
    height: 62,
    paddingHorizontal: 18,
  },
  wideSidebarPane: {
    borderRightWidth: StyleSheet.hairlineWidth,
    width: 420,
  },
  wideSidebarSubtitle: {
    fontSize: 15,
    fontWeight: "700",
    lineHeight: 19,
  },
  wideSidebarTitle: {
    fontSize: 26,
    fontWeight: "800",
    letterSpacing: -0.6,
    lineHeight: 31,
  },
  sidebarSection: {
    fontSize: 15,
    fontWeight: "700",
    letterSpacing: 0.2,
    marginBottom: 8,
    paddingHorizontal: 8,
    textTransform: "lowercase",
  },
  stack: {
    flex: 1,
  },
  swatch: {
    alignItems: "center",
    borderRadius: 30,
    height: 60,
    justifyContent: "center",
    width: 60,
  },
  swatchRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    paddingHorizontal: 22,
    paddingTop: 24,
  },
  swatchText: {
    color: "white",
    fontSize: 20,
    fontWeight: "800",
  },
  splitTitle: {
    fontSize: 32,
    fontWeight: "800",
    letterSpacing: -0.8,
    lineHeight: 36,
  },
  threadCopy: {
    flex: 1,
    gap: 3,
  },
  threadRow: {
    borderRadius: 18,
    flexDirection: "row",
    gap: 14,
    minHeight: 92,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  threadSubtitle: {
    fontSize: 15,
    lineHeight: 19,
  },
  threadTime: {
    fontSize: 15,
    lineHeight: 22,
  },
  threadTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: "700",
    letterSpacing: -0.2,
    lineHeight: 22,
  },
  threadTitleRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
  },
  title: {
    fontSize: 48,
    fontWeight: "800",
    letterSpacing: -1.6,
    lineHeight: 52,
  },
  wideSplit: {
    flex: 1,
    flexDirection: "row",
  },
});
