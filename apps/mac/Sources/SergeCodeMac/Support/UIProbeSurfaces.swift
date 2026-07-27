#if DEBUG
    import SwiftUI

    /// Live inventory of the SwiftUI surfaces the UI probe needs to assert on.
    ///
    /// Scraping the window cannot do this job. SwiftUI `Text` and
    /// `.accessibilityLabel` do not reach the AppKit accessibility tree in a
    /// headless probe run (measured: a chat window's whole text walk comes back
    /// as ~144 characters of AppKit-backed transcript, with the header title
    /// and the review pet's own label both absent), so a view built entirely
    /// from SwiftUI primitives is invisible to it. Anything inferred from the
    /// view hierarchy instead — "the deepest split's first pane is the detail
    /// column" — is a guess about SwiftUI's private layout that can start
    /// pointing at the wrong subtree without anyone noticing.
    ///
    /// So the views report themselves: a registration is written while the
    /// view is mounted and removed when it leaves.
    ///
    /// Two hazards make the bookkeeping less obvious than it looks, and both
    /// are real — each was observed in a probe run before being fixed:
    ///
    /// 1. SwiftUI re-creates a view without its state changing, and does not
    ///    order the pair: the replacement's `onAppear` can land *before* the
    ///    outgoing view's `onDisappear`. A naive unmount then deletes the
    ///    live registration and the surface reads as absent while plainly on
    ///    screen. Each registration therefore carries its own identity, and
    ///    an unmount only clears the entry it still owns.
    /// 2. A missed `onDisappear` leaves a stale entry behind. Entries carry
    ///    the thread they mounted for and lookups are thread-scoped, so a
    ///    leftover registration cannot impersonate the thread under test.
    @MainActor
    enum UIProbeSurfaces {
        struct Entry: Equatable, Sendable {
            /// Thread the surface was mounted for.
            var threadID: String
            /// Free-form state the probe asserts on (a phase name, say).
            var detail: String
            /// Identity of this particular mounting.
            var registrationID: UUID
        }

        static let activityDock = "activity-dock"
        static let reviewPet = "review-pet"

        private(set) static var entries: [String: Entry] = [:]

        static func mount(
            _ key: String, threadID: String, detail: String, registrationID: UUID
        ) {
            entries[key] = Entry(
                threadID: threadID, detail: detail, registrationID: registrationID)
        }

        /// Clears only the registration the caller still owns — see hazard 1.
        static func unmount(_ key: String, registrationID: UUID) {
            guard entries[key]?.registrationID == registrationID else { return }
            entries.removeValue(forKey: key)
        }

        /// The entry for `key`, but only if it belongs to `threadID`.
        static func entry(_ key: String, threadID: String) -> Entry? {
            guard let entry = entries[key], entry.threadID == threadID else { return nil }
            return entry
        }

        static func resetForTesting() {
            entries.removeAll()
        }
    }

    private struct ProbeSurfaceModifier: ViewModifier {
        let key: String
        let threadID: String
        let detail: String

        /// One id per mounted instance, so an outgoing view cannot clear its
        /// replacement's registration.
        @UIState private var registrationID = UUID()

        func body(content: Content) -> some View {
            content
                .onAppear {
                    UIProbeSurfaces.mount(
                        key, threadID: threadID, detail: detail,
                        registrationID: registrationID)
                }
                .onChange(of: detail) { _, newDetail in
                    UIProbeSurfaces.mount(
                        key, threadID: threadID, detail: newDetail,
                        registrationID: registrationID)
                }
                .onDisappear {
                    UIProbeSurfaces.unmount(key, registrationID: registrationID)
                }
        }
    }

    extension View {
        /// Publishes "this surface is mounted for this thread" to the probe.
        /// Call sites wrap this in `#if DEBUG`, so release builds neither
        /// carry the modifier nor pay to build its `detail` string.
        func probeSurface(_ key: String, threadID: String, detail: String) -> some View {
            modifier(ProbeSurfaceModifier(key: key, threadID: threadID, detail: detail))
        }
    }

    extension AgentActivityPhase {
        /// Stable, low-cardinality description for probe assertions.
        var probeDescription: String {
            switch self {
            case .thinking: "thinking"
            case .stalled: "stalled"
            case .tool(let tool): "tool(\(tool.kind.rawValue))"
            }
        }
    }
#endif
