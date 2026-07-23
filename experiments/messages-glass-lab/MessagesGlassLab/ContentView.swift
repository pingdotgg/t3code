import SwiftUI

struct LabThread: Identifiable, Hashable {
    let id = UUID()
    let title: String
    let subtitle: String
    let time: String
    let initials: String
    let tint: Color
    let preview: String
}

private let threads: [LabThread] = [
    .init(title: "Markdown rendering test", subtitle: "t3code · Julius’s Mac mini", time: "14h", initials: "MD", tint: .blue, preview: "Renderer stress test, terminal snippets, code blocks, and a very long markdown transcript."),
    .init(title: "iPad rectly text correction", subtitle: "Julius’s Mac mini · main", time: "16h", initials: "IP", tint: .purple, preview: "Fix iPad layout, search behavior, hardware keyboard, and trackpad scrolling."),
    .init(title: "Preview Webview Persists Off Panel", subtitle: "codething-mvp · Julius’s MacBook Pro", time: "22m", initials: "PW", tint: .teal, preview: "The browser preview should not leak outside the active panel when switching threads."),
    .init(title: "Add file preview action buttons", subtitle: "codex/connection-preview", time: "10d", initials: "FP", tint: .orange, preview: "Open files at exact lines and expose copy/open actions in the renderer."),
    .init(title: "Investigate v2 pipeline slowdown", subtitle: "codex-turn-runner", time: "1d", initials: "V2", tint: .gray, preview: "Compare orchestration traces and find why streamed events are delayed under load."),
    .init(title: "Fix dark-mode header glass", subtitle: "t3code/ipad-responsive-mobile-layout", time: "2h", initials: "DG", tint: .indigo, preview: "Compare dark scroll-edge material against Messages and Mail, then map the behavior back to React Native Screens."),
    .init(title: "Magic Keyboard sidebar scroll", subtitle: "mobile/input-polish", time: "3h", initials: "MK", tint: .cyan, preview: "Trackpad scrolling should remain fluid while swipe actions still work for touch gestures."),
    .init(title: "Terminal tab key routing", subtitle: "terminal/native-pty", time: "5h", initials: "⌘", tint: .green, preview: "Hardware Tab should go to the terminal session instead of escaping to the thread search field."),
    .init(title: "Diff renderer split inspector", subtitle: "review-diff/native", time: "8h", initials: "Δ", tint: .red, preview: "Keep file navigation, sticky headers, and selected hunk state stable in a three-column iPad layout."),
    .init(title: "Composer glass affordance", subtitle: "composer/liquid-glass", time: "9h", initials: "CG", tint: .pink, preview: "Prototype a bottom composer that feels native without covering too much content while scrolling."),
    .init(title: "Search placement audit", subtitle: "navigation/native-search", time: "11h", initials: "SP", tint: .mint, preview: "Validate whether search belongs in the bottom toolbar on iPhone and the sidebar chrome on iPad."),
    .init(title: "Thread row density pass", subtitle: "home/messages-list", time: "12h", initials: "TR", tint: .brown, preview: "Tune row height, separators, preview text, chevrons, and status glyphs to match native list rhythm."),
    .init(title: "Files navigator polish", subtitle: "files/inspector", time: "1d", initials: "FN", tint: .yellow, preview: "Make the file explorer feel like an iPad side inspector instead of a cramped web sidebar."),
    .init(title: "Toolbar grouping experiment", subtitle: "native-toolbar-glass", time: "2d", initials: "TB", tint: .blue.opacity(0.7), preview: "Compare separate glass buttons with merged toolbar groups and spacing behavior."),
    .init(title: "Scroll-edge fade comparison", subtitle: "swiftui/messages-lab", time: "3d", initials: "SE", tint: .purple.opacity(0.8), preview: "Record scroll positions to see where native headers start becoming visible over content."),
    .init(title: "iPad sidebar selection state", subtitle: "split-view/sidebar", time: "4d", initials: "SS", tint: .teal.opacity(0.75), preview: "Find the right selected-row treatment for dark and light mode in a persistent sidebar."),
    .init(title: "Preview webview panel bug", subtitle: "preview/browser", time: "5d", initials: "WB", tint: .orange.opacity(0.8), preview: "Ensure preview browser surfaces stay clipped to the active detail pane during navigation."),
    .init(title: "Keyboard shortcuts overlay", subtitle: "hardware-keyboard", time: "6d", initials: "KS", tint: .gray.opacity(0.9), preview: "Expose discoverable commands and keep focus behavior aligned with iPadOS keyboard conventions."),
    .init(title: "Thread loading skeleton", subtitle: "mobile/perceived-performance", time: "1w", initials: "LS", tint: .green.opacity(0.75), preview: "Replace jarring empty states with native-feeling loading rows while snapshots hydrate."),
    .init(title: "Connection recovery UX", subtitle: "lan-pairing", time: "2w", initials: "CR", tint: .red.opacity(0.75), preview: "Make reconnect banners and retry affordances less intrusive during scroll and composition."),
]

struct ContentView: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var searchText = ""
    @State private var selectedThread: LabThread? = threads[0]

    var body: some View {
        if horizontalSizeClass == .regular {
            NativeSplitLab(searchText: $searchText, selectedThread: $selectedThread)
        } else {
            NativePhoneLab(searchText: $searchText, selectedThread: $selectedThread)
        }
    }
}

private var filteredThreads: [LabThread] {
    threads
}

private let glassDebugCodeLines: [String] = [
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
]

private let glassDebugSwatches: [Color] = [
    .blue,
    .green,
    .orange,
    .purple,
    .cyan,
    .pink,
]

struct NativePhoneLab: View {
    @Binding var searchText: String
    @Binding var selectedThread: LabThread?

    var body: some View {
        NavigationStack {
            NativeThreadLab(thread: selectedThread ?? threads[0])
        }
    }
}

struct NativeSplitLab: View {
    @Binding var searchText: String
    @Binding var selectedThread: LabThread?

    var body: some View {
        NavigationSplitView {
            List(filteredThreads, selection: $selectedThread) { thread in
                MessageSidebarRow(thread: thread)
                    .tag(thread)
            }
            .listStyle(.sidebar)
            .navigationTitle("Threads")
            .searchable(text: $searchText, placement: .sidebar, prompt: "Search")
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Menu {
                        Button("All Threads", systemImage: "tray.full") {}
                        Button("Ready", systemImage: "checkmark.circle") {}
                        Button("Running", systemImage: "bolt.circle") {}
                    } label: {
                        Image(systemName: "line.3.horizontal.decrease")
                    }
                    .buttonStyle(.glass)

                    Button {} label: {
                        Image(systemName: "gearshape")
                    }
                    .buttonStyle(.glass)

                    Button {} label: {
                        Image(systemName: "square.and.pencil")
                    }
                    .buttonStyle(.glass)
                }
            }
        } detail: {
            if let selectedThread {
                NativeThreadLab(thread: selectedThread)
            } else {
                ContentUnavailableView("Select a thread", systemImage: "sidebar.left")
            }
        }
    }
}

struct MessageListRow: View {
    let thread: LabThread

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Circle()
                .fill(thread.tint.gradient)
                .frame(width: 52, height: 52)
                .overlay {
                    Text(thread.initials)
                        .font(.headline.weight(.bold))
                        .foregroundStyle(.white)
                }

            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(thread.title)
                        .font(.headline.weight(.semibold))
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    Text(thread.time)
                        .foregroundStyle(.secondary)
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }

                Text(thread.preview)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            .padding(.vertical, 12)
        }
    }
}

struct MessageSidebarRow: View {
    let thread: LabThread

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(thread.title)
                    .font(.headline.weight(.semibold))
                    .lineLimit(1)
                Spacer()
                Text(thread.time)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Text(thread.subtitle)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.vertical, 6)
    }
}

struct NativeThreadLab: View {
    let thread: LabThread
    @State private var draft = "Ask the repo agent, or run a command..."
    @State private var scrollStep = 0

    private let scrollTimer = Timer.publish(every: 2.8, on: .main, in: .common).autoconnect()
    private let scrollTargets = ["top", "swatches", "top", "code", "card"]

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 22) {
                    Color.clear
                        .frame(height: 0)
                        .id("top")

                    hero
                        .padding(.top, 8)

                    swatches
                        .id("swatches")

                    explanationCard
                        .id("card")

                    codeCard
                        .id("code")
                }
                .padding(.horizontal, 18)
                .padding(.top, 8)
                .padding(.bottom, 96)
            }
            .background(Color(uiColor: .systemBackground))
            .onReceive(scrollTimer) { _ in
                guard !scrollTargets.isEmpty else { return }

                let target = scrollTargets[scrollStep % scrollTargets.count]
                scrollStep += 1

                withAnimation(.smooth(duration: 1.0)) {
                    proxy.scrollTo(target, anchor: .top)
                }
            }
        }
        .navigationTitle("RNS Glass")
        .navigationSubtitle("plain react-native-screens")
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button {} label: { Image(systemName: "plus") }
                    .buttonStyle(.glass)
                Button {} label: { Image(systemName: "magnifyingglass") }
                    .buttonStyle(.glass)
            }
        }
        .safeAreaInset(edge: .bottom) {
            composer
        }
    }

    private var hero: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("plain react-native-screens")
                .font(.subheadline.weight(.bold))
                .textCase(.uppercase)
                .tracking(0.5)
                .foregroundStyle(.secondary)

            Text("Native scroll-edge glass")
                .font(.system(size: 48, weight: .heavy, design: .default))
                .lineLimit(nil)
                .minimumScaleFactor(0.72)

            Text("This route uses RNS directly. The script scrolls automatically so the native header is captured both at rest and with bright content behind it.")
                .font(.title3)
                .foregroundStyle(.secondary)
        }
    }

    private var swatches: some View {
        LazyVGrid(
            columns: [GridItem(.adaptive(minimum: 60), spacing: 12)],
            alignment: .leading,
            spacing: 12
        ) {
            ForEach(Array(glassDebugSwatches.enumerated()), id: \.offset) { index, color in
                Circle()
                    .fill(color.gradient)
                    .frame(width: 60, height: 60)
                    .overlay {
                        Text("\(index + 1)")
                            .font(.title2.weight(.heavy))
                            .foregroundStyle(.white)
                    }
            }
        }
    }

    private var explanationCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("What this isolates")
                .font(.title2.weight(.bold))

            Text("Native transparent header + iOS 26 scroll edge effect. No Expo Router header config, no custom blur overlay, no large title requirement.")
                .font(.title3)
                .foregroundStyle(.secondary)
        }
        .padding(22)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .stroke(.separator.opacity(0.35), lineWidth: 0.5)
        }
    }

    private var codeCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array((glassDebugCodeLines + glassDebugCodeLines).enumerated()), id: \.offset) { index, line in
                HStack(alignment: .top, spacing: 16) {
                    Text("\(index + 1)")
                        .foregroundStyle(.secondary)
                        .frame(width: 34, alignment: .trailing)

                    Text(line.isEmpty ? " " : line)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .font(.system(size: 16, design: .monospaced))
                .lineSpacing(4)
                .padding(.horizontal, 16)
                .padding(.vertical, 3)
            }
        }
        .padding(.vertical, 14)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(.separator.opacity(0.35), lineWidth: 0.5)
        }
    }

    private var composer: some View {
        HStack(spacing: 10) {
            Text(draft)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer()
            Image(systemName: "arrow.up")
                .font(.headline.weight(.bold))
                .frame(width: 44, height: 44)
                .glassEffect(.regular.interactive(), in: Circle())
        }
        .padding(.leading, 18)
        .padding(.trailing, 6)
        .frame(height: 56)
        .glassEffect(.clear.interactive(), in: Capsule())
        .padding(.horizontal)
        .padding(.vertical, 8)
    }
}

#Preview {
    ContentView()
}
