#if DEBUG
    import AppKit

    /// Condition-based waiting for probes.
    ///
    /// A probe runs against a live SwiftUI tree and a live model, so anything it
    /// captures or clicks has to be waited *for*, not waited *out*. A fixed
    /// sleep encodes one machine's timing: it is dead time on a fast host and a
    /// flake on a loaded one, and when it does fire early the failure looks like
    /// a UI bug rather than a scheduling one.
    @MainActor
    enum UIProbeWait {
        static let pollInterval = Duration.milliseconds(150)

        /// Polls until `condition` holds. Returns whether it ever did, so a
        /// caller can fail loudly instead of capturing a state that never
        /// arrived.
        static func until(tries: Int = 40, _ condition: @MainActor () -> Bool) async -> Bool {
            for _ in 0..<tries {
                if condition() { return true }
                try? await Task.sleep(for: pollInterval)
            }
            return condition()
        }

        /// Polls until `sample` returns the same value `settled` times running,
        /// then returns it.
        ///
        /// This is the answer to "has the list finished changing?", which has no
        /// single condition to test: a settle removes a row and a disclosure
        /// adds one, so a count read too early is neither the old value nor the
        /// new one, and a later `count > before` check would then pass on a
        /// number that was already stale.
        static func untilStable<Value: Equatable>(
            tries: Int = 40,
            settled: Int = 3,
            _ sample: @MainActor () -> Value
        ) async -> Value {
            var last = sample()
            var repeats = 1
            for _ in 0..<tries {
                try? await Task.sleep(for: pollInterval)
                let current = sample()
                if current == last {
                    repeats += 1
                    if repeats >= settled { return current }
                } else {
                    last = current
                    repeats = 1
                }
            }
            return last
        }
    }

    /// Finding the sidebar inside a hosted window. Shared by every probe that
    /// drives it, so the "which table is the sidebar" rule lives in one place.
    @MainActor
    enum UIProbeSidebar {
        /// The sidebar list, taken as the leftmost table view in the window —
        /// the inspector hosts lists of its own further right.
        static func table(in window: NSWindow) -> NSTableView? {
            guard let root = window.contentView else { return nil }
            var found: [NSTableView] = []
            func walk(_ view: NSView) {
                if let table = view as? NSTableView { found.append(table) }
                for subview in view.subviews { walk(subview) }
            }
            walk(root)
            return found.min { lhs, rhs in
                lhs.convert(lhs.bounds, to: nil).minX < rhs.convert(rhs.bounds, to: nil).minX
            }
        }

        /// Waits for the list to exist and realize its first rows. SwiftUI needs
        /// a runloop turn or two after a hosting view is installed, and how many
        /// is not something a probe can know in advance.
        static func waitForTable(in window: NSWindow) async -> NSTableView? {
            var table: NSTableView?
            _ = await UIProbeWait.until {
                table = UIProbeSidebar.table(in: window)
                return (table?.numberOfRows ?? 0) > 0
            }
            return (table?.numberOfRows ?? 0) > 0 ? table : nil
        }
    }
#endif
