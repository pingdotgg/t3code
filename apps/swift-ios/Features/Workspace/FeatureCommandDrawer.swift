import CoreGraphics
import Foundation

/// Geometry for the command palette's top drawer.
///
/// The palette is a physical drawer hanging above the top edge of the
/// workspace: the finger pulls it down, the page below travels with it, and
/// releasing settles it to one of two rest positions. Every value here is a
/// pure function of the drag so the motion can be verified without UI
/// automation, and so the drawer never borrows a bottom-sheet presentation
/// whose animation would disagree with the direction of the finger.
enum FeatureCommandDrawerGeometry {
    /// Floor so an unusually tall keyboard cannot squeeze the drawer shut.
    static let minimumOpenHeight: CGFloat = 220
    /// Share of the drag that keeps travelling once the drawer is fully out.
    static let overshootResistance: CGFloat = 0.22
    /// Travel away from the rest position the drawer started at that commits
    /// the release to the other rest position.
    ///
    /// This is an absolute distance rather than a fraction of the open height
    /// on purpose. The drawer opens to the full page, so a fraction made an
    /// ordinary swipe — a hundred points or so — fall far short of committing,
    /// and the palette could only be opened by dragging a third of the screen
    /// or flicking hard. A swipe is a swipe regardless of how tall the drawer
    /// it is pulling happens to be.
    static let settleCommitDistance: CGFloat = 96
    /// How far ahead of the release the drawer's momentum is projected, so a
    /// short fast swipe commits on the speed it was thrown at.
    static let settleProjectionInterval: CGFloat = 0.14

    /// Height a docked software keyboard covers inside the hosting window.
    ///
    /// Keyboard notifications report screen coordinates. Floating, split, and
    /// undocked iPad keyboards must not shorten the full-width drawer, so the
    /// frame only counts when it spans the window and reaches its bottom edge.
    static func keyboardOverlap(keyboardFrame: CGRect, windowFrame: CGRect) -> CGFloat {
        guard windowFrame.width > 0,
              windowFrame.height > 0,
              keyboardFrame.minX <= windowFrame.minX,
              keyboardFrame.maxX >= windowFrame.maxX,
              keyboardFrame.maxY >= windowFrame.maxY
        else { return 0 }

        let overlap = keyboardFrame.intersection(windowFrame)
        return overlap.isNull ? 0 : overlap.height
    }

    /// Fully open covers the whole page: the drawer runs from the top of the
    /// screen down to the keyboard's top edge, or to the home indicator when
    /// there is no keyboard. No part of the page underneath stays visible.
    ///
    /// `availableHeight` must be the page height *before* keyboard avoidance
    /// shrinks it, and `bottomInset` the home-indicator inset it already
    /// excludes. The keyboard is measured from the bottom of the screen, so it
    /// only intrudes into the page by whatever it covers beyond that inset —
    /// subtracting its full height from an already-shrunken page counts the
    /// keyboard twice and leaves a band of page showing beneath the drawer.
    static func openHeight(
        availableHeight: CGFloat,
        keyboardHeight: CGFloat = 0,
        bottomInset: CGFloat = 0
    ) -> CGFloat {
        guard availableHeight > 0 else { return 0 }
        let intrusion = max(0, keyboardHeight - max(0, bottomInset))
        let exposed = availableHeight - intrusion
        return max(exposed, min(minimumOpenHeight, availableHeight))
    }

    /// Where the open drawer's bottom edge lands in window coordinates. The
    /// drawer is only correct when this meets the top of whatever is below it.
    static func openEdge(
        windowHeight: CGFloat,
        topInset: CGFloat,
        bottomInset: CGFloat,
        keyboardHeight: CGFloat = 0
    ) -> CGFloat {
        let pageHeight = windowHeight - topInset - bottomInset
        return topInset + openHeight(
            availableHeight: pageHeight,
            keyboardHeight: keyboardHeight,
            bottomInset: bottomInset
        )
    }

    /// Drawer edge position for a drag, measured down from the closed edge.
    static func reveal(
        baseReveal: CGFloat,
        translation: CGFloat,
        openHeight: CGFloat
    ) -> CGFloat {
        guard openHeight > 0 else { return 0 }
        let raw = baseReveal + translation
        guard raw > 0 else { return 0 }
        guard raw > openHeight else { return raw }
        return openHeight + (raw - openHeight) * overshootResistance
    }

    /// Where the drawer layer sits for a given reveal, measured from the top of
    /// the page it is laid out in.
    ///
    /// The drawer is presented *over* the workspace rather than pushing it: the
    /// page underneath never translates, so this offset carries the entire
    /// travel of the pull. At rest the whole drawer, including the window's top
    /// inset it draws under, hangs above the top edge; at full reveal its
    /// bottom edge lands at `topInset + openHeight` and its top sits exactly on
    /// the window's top edge.
    static func drawerOffset(
        reveal: CGFloat,
        openHeight: CGFloat,
        topInset: CGFloat
    ) -> CGFloat {
        reveal - openHeight - topInset
    }

    static func progress(reveal: CGFloat, openHeight: CGFloat) -> CGFloat {
        guard openHeight > 0 else { return 0 }
        return min(max(reveal / openHeight, 0), 1)
    }

    /// Distance the drawer must travel away from where the drag started before
    /// the release commits to the opposite rest position. Never more than half
    /// the drawer, so a short drawer stays reachable in both directions.
    static func commitDistance(openHeight: CGFloat) -> CGFloat {
        min(settleCommitDistance, openHeight * 0.5)
    }

    /// Where the drawer's edge is heading when the finger lifts. Position and
    /// speed are the same quantity here, so a slow drag past the commit
    /// distance and a fast flick short of it both settle the way they look.
    static func projectedReveal(reveal: CGFloat, velocity: CGFloat) -> CGFloat {
        reveal + velocity * settleProjectionInterval
    }

    /// The settle is measured from the rest position the drag started at: an
    /// opening pull commits once it has travelled the commit distance out, and
    /// a closing push commits once it has travelled the same distance back.
    /// Symmetry is what makes the drawer feel physical — otherwise the release
    /// that opens it and the release that closes it answer to different rules.
    static func settlesOpen(
        reveal: CGFloat,
        velocity: CGFloat,
        openHeight: CGFloat,
        wasOpen: Bool
    ) -> Bool {
        guard openHeight > 0 else { return false }
        let projected = projectedReveal(reveal: reveal, velocity: velocity)
        let commit = commitDistance(openHeight: openHeight)
        return wasOpen
            ? projected > openHeight - commit
            : projected >= commit
    }
}

/// Which touches may start the command gesture, and in which direction.
///
/// Home's thread list and the thread transcript are native scroll views, so the
/// drawer must never be able to claim an ordinary drag from the middle of
/// either one. Eligibility is therefore a narrow band that tracks the drawer's
/// own leading edge: the top bar while the drawer is closed, and the drawer's
/// handle plus a little of the scrim beneath it while the drawer is open.
enum FeatureCommandDrawerGesture {
    /// Band below the top inset that can start the pull, sized to the top bar.
    static let topGrabHeight: CGFloat = 56
    /// Band above the open drawer's edge, covering its handle.
    static let handleGrabHeight: CGFloat = 56
    /// Band below the open drawer's edge, covering the nearest scrim.
    static let scrimGrabHeight: CGFloat = 64
    static let verticalToHorizontalRatio: CGFloat = 1.4
    static let minimumDirectionDistance: CGFloat = 8

    /// Bands are expressed in window coordinates: the closed drawer's edge sits
    /// at the top safe-area boundary, so `reveal` is measured from there.
    static func grabBand(reveal: CGFloat, topInset: CGFloat) -> ClosedRange<CGFloat> {
        guard reveal > 0 else {
            return topInset...(topInset + topGrabHeight)
        }
        let edge = topInset + reveal
        return (edge - handleGrabHeight)...(edge + scrimGrabHeight)
    }

    static func canBeginTouch(
        atY y: CGFloat,
        reveal: CGFloat,
        topInset: CGFloat
    ) -> Bool {
        grabBand(reveal: reveal, topInset: topInset).contains(y)
    }

    /// Mirrors the detail surface's back-swipe policy: prefer real travel once
    /// there is any, fall back to velocity at gesture-begin time, and require
    /// the motion to be clearly vertical before claiming it.
    static func shouldBegin(
        velocity: CGPoint,
        translation: CGPoint,
        isOpen: Bool
    ) -> Bool {
        let direction = hypot(translation.x, translation.y) >= minimumDirectionDistance
            ? translation
            : velocity
        guard abs(direction.y) >= abs(direction.x) * verticalToHorizontalRatio else {
            return false
        }
        return isOpen ? direction.y != 0 : direction.y > 0
    }
}

/// Presentation state of the drawer. Drag updates are absolute against the
/// reveal captured when the drag began, so a drag that starts on a partly
/// settled drawer stays attached to the finger instead of jumping.
struct FeatureCommandDrawerState: Equatable, Sendable {
    private(set) var reveal: CGFloat = 0
    private(set) var isOpen = false
    private(set) var isDragging = false
    private var dragBaseline: CGFloat = 0

    var isVisible: Bool { isOpen || isDragging || reveal > 0 }

    mutating func beginDrag() {
        isDragging = true
        dragBaseline = reveal
    }

    mutating func updateDrag(translation: CGFloat, openHeight: CGFloat) {
        guard isDragging else { return }
        reveal = FeatureCommandDrawerGeometry.reveal(
            baseReveal: dragBaseline,
            translation: translation,
            openHeight: openHeight
        )
    }

    @discardableResult
    mutating func endDrag(velocity: CGFloat, openHeight: CGFloat) -> Bool {
        guard isDragging else { return isOpen }
        let opens = FeatureCommandDrawerGeometry.settlesOpen(
            reveal: reveal,
            velocity: velocity,
            openHeight: openHeight,
            wasOpen: isOpen
        )
        settle(open: opens, openHeight: openHeight)
        return opens
    }

    /// A cancelled pan returns to the rest position the drawer came from.
    mutating func cancelDrag(openHeight: CGFloat) {
        guard isDragging else { return }
        settle(open: isOpen, openHeight: openHeight)
    }

    /// Closing needs no geometry: the closed rest position is always the edge.
    mutating func close() {
        isDragging = false
        isOpen = false
        reveal = 0
        dragBaseline = 0
    }

    mutating func settle(open: Bool, openHeight: CGFloat) {
        isDragging = false
        isOpen = open
        reveal = open ? openHeight : 0
        dragBaseline = reveal
    }

    /// Keeps a settled drawer pinned to its edge when the viewport resizes.
    mutating func synchronize(openHeight: CGFloat) {
        guard !isDragging else { return }
        reveal = isOpen ? openHeight : 0
        dragBaseline = reveal
    }
}

/// When the palette's search field owns the keyboard.
///
/// The drawer is a typing surface, so focus follows presentation rather than a
/// separate tap: the keyboard comes up as soon as the pull starts, which also
/// means the drawer's fully-open height is already keyboard-constrained by the
/// time the drag is released and the settle lands in one motion.
enum FeatureCommandDrawerFocus {
    static func searchIsFocused(for state: FeatureCommandDrawerState) -> Bool {
        state.isVisible
    }

    /// Whether the focus request has to be made again.
    ///
    /// Asking at the start of the pull is what puts the keyboard's height into
    /// the open height before the finger lifts, but at that moment the search
    /// field is still above the window's top edge, and a request for a field
    /// that is not on screen yet can simply be dropped. A long drag hid that:
    /// the field was on screen for most of a second before the release, so a
    /// later pass took the focus anyway. An ordinary swipe settles in a quarter
    /// of a second, so the drawer can arrive at its rest position with nothing
    /// focused and no further state change to trigger a retry.
    ///
    /// The answer is therefore not "has it been asked" but "is the drawer open
    /// and still unfocused" — which stays true until the request actually
    /// lands, and is false as soon as it does.
    static func needsFocusRenewal(
        state: FeatureCommandDrawerState,
        isFocused: Bool
    ) -> Bool {
        state.isOpen && !isFocused
    }
}

enum FeatureCommandDrawerAction: String, CaseIterable, Equatable, Sendable {
    case newTask
    case addProject
    case settings
    case allProjects

    var title: String {
        switch self {
        case .newTask: "New task"
        case .addProject: "Add project"
        case .settings: "Settings"
        case .allProjects: "Show all projects"
        }
    }

    var systemImage: String {
        switch self {
        case .newTask: "square.and.pencil"
        case .addProject: "folder.badge.plus"
        case .settings: "slider.horizontal.3"
        case .allProjects: "line.3.horizontal.decrease"
        }
    }
}

enum FeatureCommandDrawerItem: Identifiable, Equatable, Sendable {
    case action(FeatureCommandDrawerAction)
    case project(id: String, name: String)
    case thread(id: String, title: String, projectName: String?)

    var id: String {
        switch self {
        case let .action(action): "action:\(action.rawValue)"
        case let .project(id, _): "project:\(id)"
        case let .thread(id, _, _): "thread:\(id)"
        }
    }

    var title: String {
        switch self {
        case let .action(action): action.title
        case let .project(_, name): name
        case let .thread(_, title, _): title
        }
    }

    var subtitle: String? {
        switch self {
        case .action: nil
        case .project: "Filter Home to this project"
        case let .thread(_, _, projectName): projectName
        }
    }

    var systemImage: String {
        switch self {
        case let .action(action): action.systemImage
        case .project: "folder"
        case .thread: "bubble.left.and.text.bubble.right"
        }
    }
}

/// Builds the drawer's rows from workspace data that is already loaded.
///
/// This is a plain substring filter on purpose: the drawer's contribution is
/// the physical presentation, and ranked fuzzy search would be a separate
/// behavior with its own acceptance.
enum FeatureCommandDrawerCatalog {
    static let threadLimit = 8
    static let projectLimit = 6

    static func items(
        projects: [FeatureProject],
        threads: [FeatureThread],
        selectedProjectID: String?,
        query: String
    ) -> [FeatureCommandDrawerItem] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return actionItems(selectedProjectID: selectedProjectID, query: trimmed)
            + threadItems(threads: threads, projects: projects, query: trimmed)
            + projectItems(projects: projects, query: trimmed)
    }

    private static func actionItems(
        selectedProjectID: String?,
        query: String
    ) -> [FeatureCommandDrawerItem] {
        var actions: [FeatureCommandDrawerAction] = [.newTask, .addProject, .settings]
        if selectedProjectID != nil {
            actions.insert(.allProjects, at: 0)
        }
        return actions
            .filter { matches($0.title, query: query) }
            .map(FeatureCommandDrawerItem.action)
    }

    private static func threadItems(
        threads: [FeatureThread],
        projects: [FeatureProject],
        query: String
    ) -> [FeatureCommandDrawerItem] {
        let names = Dictionary(
            projects.map { ($0.id, $0.name) },
            uniquingKeysWith: { first, _ in first }
        )
        return threads
            .filter { !$0.isArchived && matches($0.title, query: query) }
            .sorted {
                let left = activity(of: $0)
                let right = activity(of: $1)
                return left == right ? $0.id < $1.id : left > right
            }
            .prefix(threadLimit)
            .map { .thread(id: $0.id, title: $0.title, projectName: names[$0.projectID]) }
    }

    private static func projectItems(
        projects: [FeatureProject],
        query: String
    ) -> [FeatureCommandDrawerItem] {
        projects
            .filter { matches($0.name, query: query) }
            .prefix(projectLimit)
            .map { .project(id: $0.id, name: $0.name) }
    }

    private static func activity(of thread: FeatureThread) -> Date {
        thread.lastActivityAt ?? thread.updatedAt
    }

    private static func matches(_ candidate: String, query: String) -> Bool {
        guard !query.isEmpty else { return true }
        return candidate.localizedCaseInsensitiveContains(query)
    }
}
