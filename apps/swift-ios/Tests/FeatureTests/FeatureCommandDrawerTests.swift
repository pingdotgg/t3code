import CoreGraphics
import Foundation
import Testing
@testable import T3Code

@Suite("Command palette top drawer")
struct FeatureCommandDrawerTests {
    // MARK: - Geometry

    @Test
    func fullyOpenFillsEveryPointAboveTheKeyboard() {
        // With the keyboard up, the drawer stops exactly where the keyboard
        // starts rather than settling at some fraction of the screen.
        #expect(
            FeatureCommandDrawerGeometry.openHeight(
                availableHeight: 778,
                keyboardHeight: 336
            ) == 442
        )
        // Without a keyboard it simply takes the whole page.
        #expect(FeatureCommandDrawerGeometry.openHeight(availableHeight: 778) == 778)
        #expect(
            FeatureCommandDrawerGeometry.openHeight(
                availableHeight: 778,
                keyboardHeight: 0
            ) == 778
        )
    }

    @Test
    func anOversizedKeyboardCannotSqueezeTheDrawerShut() {
        // Floor keeps the palette usable when the keyboard is unusually tall.
        #expect(
            FeatureCommandDrawerGeometry.openHeight(
                availableHeight: 500,
                keyboardHeight: 460
            ) == FeatureCommandDrawerGeometry.minimumOpenHeight
        )
        // The floor never exceeds the space that actually exists.
        #expect(
            FeatureCommandDrawerGeometry.openHeight(
                availableHeight: 180,
                keyboardHeight: 170
            ) == 180
        )
        #expect(FeatureCommandDrawerGeometry.openHeight(availableHeight: 0) == 0)
        // A negative or absent report is treated as no keyboard at all.
        #expect(
            FeatureCommandDrawerGeometry.openHeight(
                availableHeight: 778,
                keyboardHeight: -40
            ) == 778
        )
    }

    @Test
    func presentingTheDrawerGivesTheSearchFieldTheKeyboard() {
        var state = FeatureCommandDrawerState()
        #expect(FeatureCommandDrawerFocus.searchIsFocused(for: state) == false)

        // The pull itself focuses, so the keyboard is already up — and already
        // accounted for in the open height — by the time the drag is released.
        state.beginDrag()
        state.updateDrag(translation: 30, openHeight: 442)
        #expect(FeatureCommandDrawerFocus.searchIsFocused(for: state))

        state.settle(open: true, openHeight: 442)
        #expect(FeatureCommandDrawerFocus.searchIsFocused(for: state))

        state.close()
        #expect(FeatureCommandDrawerFocus.searchIsFocused(for: state) == false)
    }

    @Test
    func anAbandonedPullTakesTheKeyboardBackDownWithIt() {
        var state = FeatureCommandDrawerState()
        state.beginDrag()
        state.updateDrag(translation: 40, openHeight: 442)
        #expect(FeatureCommandDrawerFocus.searchIsFocused(for: state))

        let opened = state.endDrag(velocity: 0, openHeight: 442)
        #expect(opened == false)
        #expect(FeatureCommandDrawerFocus.searchIsFocused(for: state) == false)
    }

    @Test
    func revealTracksTheFingerOneToOneWhileTheDrawerIsComingOut() {
        for travel in stride(from: CGFloat(0), through: 400, by: 50) {
            #expect(
                FeatureCommandDrawerGeometry.reveal(
                    baseReveal: 0,
                    translation: travel,
                    openHeight: 420
                ) == travel
            )
        }
    }

    @Test
    func revealClampsAtTheClosedEdgeAndResistsPastFullyOpen() {
        #expect(
            FeatureCommandDrawerGeometry.reveal(
                baseReveal: 0,
                translation: -120,
                openHeight: 420
            ) == 0
        )

        let overshoot = FeatureCommandDrawerGeometry.reveal(
            baseReveal: 0,
            translation: 520,
            openHeight: 420
        )
        #expect(overshoot > 420)
        #expect(overshoot < 520)
        #expect(abs(overshoot - (420 + 100 * 0.22)) < 0.0001)
    }

    @Test
    func revealIsAbsoluteAgainstTheDragBaselineSoAnOpenDrawerDoesNotJump() {
        // A drag that starts on the open drawer begins where the finger is.
        #expect(
            FeatureCommandDrawerGeometry.reveal(
                baseReveal: 420,
                translation: 0,
                openHeight: 420
            ) == 420
        )
        #expect(
            FeatureCommandDrawerGeometry.reveal(
                baseReveal: 420,
                translation: -150,
                openHeight: 420
            ) == 270
        )
    }

    @Test
    func progressIsTheClampedFractionOfTheOpenHeight() {
        #expect(FeatureCommandDrawerGeometry.progress(reveal: 0, openHeight: 400) == 0)
        #expect(FeatureCommandDrawerGeometry.progress(reveal: 200, openHeight: 400) == 0.5)
        #expect(FeatureCommandDrawerGeometry.progress(reveal: 460, openHeight: 400) == 1)
        #expect(FeatureCommandDrawerGeometry.progress(reveal: 100, openHeight: 0) == 0)
    }

    // MARK: - Settle thresholds

    @Test
    func releasingBeforeTheThresholdSettlesClosedAndAfterItSettlesOpen() {
        let openHeight: CGFloat = 400
        let threshold = openHeight * FeatureCommandDrawerGeometry.settleProgressThreshold

        #expect(
            FeatureCommandDrawerGeometry.settlesOpen(
                reveal: threshold - 1,
                velocity: 0,
                openHeight: openHeight
            ) == false
        )
        #expect(
            FeatureCommandDrawerGeometry.settlesOpen(
                reveal: threshold,
                velocity: 0,
                openHeight: openHeight
            )
        )
    }

    @Test
    func aFlickDecidesTheSettleRegardlessOfHowFarTheDrawerTravelled() {
        let openHeight: CGFloat = 400
        // Short downward flick still opens.
        #expect(
            FeatureCommandDrawerGeometry.settlesOpen(
                reveal: 40,
                velocity: FeatureCommandDrawerGeometry.settleVelocity,
                openHeight: openHeight
            )
        )
        // Upward flick from a nearly open drawer still closes.
        #expect(
            FeatureCommandDrawerGeometry.settlesOpen(
                reveal: 380,
                velocity: -FeatureCommandDrawerGeometry.settleVelocity,
                openHeight: openHeight
            ) == false
        )
        // A slow drag below the flick speed keeps using the position threshold.
        #expect(
            FeatureCommandDrawerGeometry.settlesOpen(
                reveal: 380,
                velocity: -(FeatureCommandDrawerGeometry.settleVelocity - 1),
                openHeight: openHeight
            )
        )
    }

    // MARK: - Gesture eligibility (issue #82)

    @Test
    func onlyTheTopBarBandCanStartTheGestureWhileTheDrawerIsClosed() {
        let topInset: CGFloat = 62

        // Inside the top bar.
        #expect(
            FeatureCommandDrawerGesture.canBeginTouch(atY: 62, reveal: 0, topInset: topInset)
        )
        #expect(
            FeatureCommandDrawerGesture.canBeginTouch(atY: 110, reveal: 0, topInset: topInset)
        )
        // Above the top bar is system chrome, not the app's drawer handle.
        #expect(
            FeatureCommandDrawerGesture.canBeginTouch(atY: 20, reveal: 0, topInset: topInset)
                == false
        )
        // The middle and bottom of the Home thread list must stay scrollable.
        for y in [200, 320, 480, 700] as [CGFloat] {
            #expect(
                FeatureCommandDrawerGesture.canBeginTouch(atY: y, reveal: 0, topInset: topInset)
                    == false
            )
        }
    }

    @Test
    func theOpenDrawerIsGrabbedByItsOwnEdgeInsteadOfTheTopOfTheScreen() {
        let reveal: CGFloat = 420
        let topInset: CGFloat = 62
        // In window coordinates the open drawer's edge is below the inset.
        let edge = topInset + reveal

        #expect(
            FeatureCommandDrawerGesture.canBeginTouch(
                atY: edge, reveal: reveal, topInset: topInset
            )
        )
        // The handle just above the edge, and the scrim just below it.
        #expect(
            FeatureCommandDrawerGesture.canBeginTouch(
                atY: edge - 40, reveal: reveal, topInset: topInset
            )
        )
        #expect(
            FeatureCommandDrawerGesture.canBeginTouch(
                atY: edge + 50, reveal: reveal, topInset: topInset
            )
        )
        // The drawer's own scrollable result list keeps its drags.
        #expect(
            FeatureCommandDrawerGesture.canBeginTouch(
                atY: 240, reveal: reveal, topInset: topInset
            ) == false
        )
        // So does the page far below the drawer.
        #expect(
            FeatureCommandDrawerGesture.canBeginTouch(
                atY: 700, reveal: reveal, topInset: topInset
            ) == false
        )
        // The top bar band no longer applies once the drawer is out.
        #expect(
            FeatureCommandDrawerGesture.canBeginTouch(
                atY: topInset + 10, reveal: reveal, topInset: topInset
            ) == false
        )
    }

    @Test
    func theGestureClaimsOnlyClearlyVerticalMotionInTheRightDirection() {
        // Downward pull opens.
        #expect(
            FeatureCommandDrawerGesture.shouldBegin(
                velocity: CGPoint(x: 0, y: 600),
                translation: .zero,
                isOpen: false
            )
        )
        // An upward drag on a closed drawer is not the command gesture.
        #expect(
            FeatureCommandDrawerGesture.shouldBegin(
                velocity: CGPoint(x: 0, y: -600),
                translation: .zero,
                isOpen: false
            ) == false
        )
        // A mostly horizontal drag belongs to back-swipe and swipe actions.
        #expect(
            FeatureCommandDrawerGesture.shouldBegin(
                velocity: CGPoint(x: 500, y: 200),
                translation: .zero,
                isOpen: false
            ) == false
        )
        // Real travel wins over the initial velocity estimate once it exists.
        #expect(
            FeatureCommandDrawerGesture.shouldBegin(
                velocity: CGPoint(x: 0, y: -600),
                translation: CGPoint(x: 2, y: 40),
                isOpen: false
            )
        )
        // An open drawer accepts the upward push that closes it.
        #expect(
            FeatureCommandDrawerGesture.shouldBegin(
                velocity: CGPoint(x: 0, y: -600),
                translation: .zero,
                isOpen: true
            )
        )
    }

    // MARK: - Presentation state

    @Test
    func aCompletedPullOpensTheDrawerAtItsRestPosition() {
        var state = FeatureCommandDrawerState()
        #expect(state.isVisible == false)

        state.beginDrag()
        state.updateDrag(translation: 120, openHeight: 400)
        #expect(state.reveal == 120)
        #expect(state.isDragging)
        #expect(state.isOpen == false)
        #expect(state.isVisible)

        state.updateDrag(translation: 300, openHeight: 400)
        #expect(state.reveal == 300)

        let opened = state.endDrag(velocity: 0, openHeight: 400)
        #expect(opened)
        #expect(state.isOpen)
        #expect(state.isDragging == false)
        #expect(state.reveal == 400)
    }

    @Test
    func releasingBeforeTheThresholdReturnsTheDrawerToTheClosedEdge() {
        var state = FeatureCommandDrawerState()
        state.beginDrag()
        state.updateDrag(translation: 90, openHeight: 400)

        let opened = state.endDrag(velocity: 0, openHeight: 400)
        #expect(opened == false)
        #expect(state.isOpen == false)
        #expect(state.reveal == 0)
        #expect(state.isVisible == false)
    }

    @Test
    func aSecondDragStartsFromWhereTheDrawerAlreadyIs() {
        var state = FeatureCommandDrawerState()
        state.settle(open: true, openHeight: 400)

        state.beginDrag()
        // The very first callback of a new drag must not move the drawer.
        state.updateDrag(translation: 0, openHeight: 400)
        #expect(state.reveal == 400)

        state.updateDrag(translation: -260, openHeight: 400)
        #expect(state.reveal == 140)
        let opened = state.endDrag(velocity: 0, openHeight: 400)
        #expect(opened == false)
        #expect(state.reveal == 0)
    }

    @Test
    func aCancelledPanReturnsToTheRestPositionItStartedFrom() {
        var state = FeatureCommandDrawerState()
        state.settle(open: true, openHeight: 400)
        state.beginDrag()
        state.updateDrag(translation: -200, openHeight: 400)

        state.cancelDrag(openHeight: 400)
        #expect(state.isOpen)
        #expect(state.reveal == 400)
        #expect(state.isDragging == false)
    }

    @Test
    func dragUpdatesAreIgnoredUntilADragActuallyBegins() {
        var state = FeatureCommandDrawerState()
        state.updateDrag(translation: 300, openHeight: 400)

        #expect(state.reveal == 0)
        let opened = state.endDrag(velocity: 900, openHeight: 400)
        #expect(opened == false)
        #expect(state.isOpen == false)
    }

    @Test
    func closingAndResizingKeepTheDrawerPinnedToItsEdge() {
        var state = FeatureCommandDrawerState()
        state.settle(open: true, openHeight: 400)

        // A keyboard or rotation change resizes the viewport under an open drawer.
        state.synchronize(openHeight: 300)
        #expect(state.reveal == 300)
        #expect(state.isOpen)

        state.close()
        #expect(state.isOpen == false)
        #expect(state.reveal == 0)

        // Resizing a closed drawer leaves it closed.
        state.synchronize(openHeight: 500)
        #expect(state.reveal == 0)
    }

    @Test
    func aResizeDuringADragDoesNotFightTheFinger() {
        var state = FeatureCommandDrawerState()
        state.beginDrag()
        state.updateDrag(translation: 150, openHeight: 400)

        state.synchronize(openHeight: 300)
        #expect(state.reveal == 150)
        #expect(state.isDragging)
    }

    // MARK: - Catalog

    @Test
    func theDrawerOffersTheWorkspaceActionsAndRecentThreadsByDefault() {
        let items = FeatureCommandDrawerCatalog.items(
            projects: [project("alpha", name: "Alpha")],
            threads: [
                thread("old", projectID: "alpha", title: "Older task", activity: 10),
                thread("new", projectID: "alpha", title: "Newer task", activity: 20),
            ],
            selectedProjectID: nil,
            query: ""
        )

        #expect(
            items.map(\.id) == [
                "action:newTask",
                "action:addProject",
                "action:settings",
                "thread:new",
                "thread:old",
                "project:alpha",
            ]
        )
    }

    @Test
    func clearingTheProjectFilterIsOfferedOnlyWhileAFilterIsApplied() {
        let projects = [project("alpha", name: "Alpha")]

        #expect(
            FeatureCommandDrawerCatalog.items(
                projects: projects,
                threads: [],
                selectedProjectID: "alpha",
                query: ""
            ).first?.id == "action:allProjects"
        )
        #expect(
            FeatureCommandDrawerCatalog.items(
                projects: projects,
                threads: [],
                selectedProjectID: nil,
                query: ""
            ).contains { $0.id == "action:allProjects" } == false
        )
    }

    @Test
    func theQueryFiltersActionsThreadsAndProjectsTogether() {
        let items = FeatureCommandDrawerCatalog.items(
            projects: [project("alpha", name: "Alpha"), project("beta", name: "Beta")],
            threads: [
                thread("a", projectID: "alpha", title: "Ship the alpha drawer", activity: 30),
                thread("b", projectID: "beta", title: "Unrelated", activity: 40),
            ],
            selectedProjectID: nil,
            query: "  ALPHA "
        )

        #expect(items.map(\.id) == ["thread:a", "project:alpha"])
    }

    @Test
    func archivedThreadsStayOutOfTheDrawerAndResultsAreBounded() {
        let threads = (0..<20).map {
            thread("t\($0)", projectID: "alpha", title: "Task \($0)", activity: TimeInterval($0))
        } + [thread("gone", projectID: "alpha", title: "Task archived", activity: 999, isArchived: true)]

        let items = FeatureCommandDrawerCatalog.items(
            projects: (0..<10).map { project("p\($0)", name: "Project \($0)") },
            threads: threads,
            selectedProjectID: nil,
            query: ""
        )

        let threadIDs = items.compactMap { item -> String? in
            guard case let .thread(id, _, _) = item else { return nil }
            return id
        }
        let projectIDs = items.compactMap { item -> String? in
            guard case let .project(id, _) = item else { return nil }
            return id
        }
        #expect(threadIDs.count == FeatureCommandDrawerCatalog.threadLimit)
        #expect(threadIDs.first == "t19")
        #expect(threadIDs.contains("gone") == false)
        #expect(projectIDs.count == FeatureCommandDrawerCatalog.projectLimit)
    }

    @Test
    func threadRowsCarryTheirProjectNameForDisambiguation() {
        let items = FeatureCommandDrawerCatalog.items(
            projects: [project("alpha", name: "Alpha")],
            threads: [
                thread("known", projectID: "alpha", title: "Known", activity: 20),
                thread("orphan", projectID: "missing", title: "Orphan", activity: 10),
            ],
            selectedProjectID: nil,
            query: "n"
        )

        #expect(
            items.contains { $0 == .thread(id: "known", title: "Known", projectName: "Alpha") }
        )
        #expect(
            items.contains { $0 == .thread(id: "orphan", title: "Orphan", projectName: nil) }
        )
    }

    // MARK: - Fixtures

    private func project(_ id: String, name: String) -> FeatureProject {
        FeatureProject(id: id, environmentID: "env", name: name, path: "/tmp/\(id)")
    }

    private func thread(
        _ id: String,
        projectID: String,
        title: String,
        activity: TimeInterval,
        isArchived: Bool = false
    ) -> FeatureThread {
        FeatureThread(
            id: id,
            projectID: projectID,
            title: title,
            updatedAt: Date(timeIntervalSince1970: activity),
            isArchived: isArchived,
            lastActivityAt: Date(timeIntervalSince1970: activity)
        )
    }
}
