import CoreGraphics
import Foundation
import Testing
@testable import T3Code

@Suite("Command palette top drawer")
struct FeatureCommandDrawerTests {
    // MARK: - Geometry

    // iPhone-shaped window used for the coverage invariants below.
    private static let windowHeight: CGFloat = 874
    private static let topInset: CGFloat = 62
    private static let bottomInset: CGFloat = 34
    private static let keyboardHeight: CGFloat = 336

    @Test
    func theOpenDrawersBottomEdgeMeetsTheTopOfTheKeyboard() {
        // The rejected build left a band of the page showing between the
        // drawer and the keyboard. The drawer's edge must land exactly on the
        // keyboard's top edge so nothing underneath is visible.
        let edge = FeatureCommandDrawerGeometry.openEdge(
            windowHeight: Self.windowHeight,
            topInset: Self.topInset,
            bottomInset: Self.bottomInset,
            keyboardHeight: Self.keyboardHeight
        )
        let keyboardTop = Self.windowHeight - Self.keyboardHeight

        #expect(edge == keyboardTop)
        #expect(edge == 538)
    }

    @Test
    func withoutAKeyboardTheDrawerReachesTheHomeIndicator() {
        let edge = FeatureCommandDrawerGeometry.openEdge(
            windowHeight: Self.windowHeight,
            topInset: Self.topInset,
            bottomInset: Self.bottomInset
        )
        // Everything above the home indicator is covered.
        #expect(edge == Self.windowHeight - Self.bottomInset)
        #expect(edge == 840)
    }

    @Test
    func theKeyboardIsNeverSubtractedTwice() {
        // The page height already excludes the home indicator, and the keyboard
        // is measured from the bottom of the screen, so only the part of the
        // keyboard beyond that inset actually covers page content.
        let pageHeight = Self.windowHeight - Self.topInset - Self.bottomInset
        let open = FeatureCommandDrawerGeometry.openHeight(
            availableHeight: pageHeight,
            keyboardHeight: Self.keyboardHeight,
            bottomInset: Self.bottomInset
        )
        #expect(open == pageHeight - (Self.keyboardHeight - Self.bottomInset))
        #expect(open == 476)

        // Ignoring the inset would shorten the drawer by the inset and expose
        // that much of the page; guard against regressing to it.
        #expect(open != pageHeight - Self.keyboardHeight)
    }

    @Test
    func withoutAKeyboardTheDrawerCoversTheWholePage() {
        #expect(FeatureCommandDrawerGeometry.openHeight(availableHeight: 778) == 778)
        #expect(
            FeatureCommandDrawerGeometry.openHeight(
                availableHeight: 778,
                keyboardHeight: 0,
                bottomInset: 34
            ) == 778
        )
        // A keyboard that only covers the home indicator takes nothing from it.
        #expect(
            FeatureCommandDrawerGeometry.openHeight(
                availableHeight: 778,
                keyboardHeight: 30,
                bottomInset: 34
            ) == 778
        )
    }

    @Test
    func anOversizedKeyboardCannotSqueezeTheDrawerShut() {
        // Floor keeps the palette usable when the keyboard is unusually tall.
        #expect(
            FeatureCommandDrawerGeometry.openHeight(
                availableHeight: 500,
                keyboardHeight: 480,
                bottomInset: 0
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

    // MARK: - Presented over the page (issue #122 rework)

    @Test
    func theDrawerCarriesTheWholeTravelSoThePageUnderneathNeverMoves() {
        // Alex rejected the build where the page translated with the drawer:
        // the whole screen looked shoved downwards. The drawer is presented
        // over the workspace, so every point of the pull has to land in the
        // drawer's own offset and nothing else.
        let openHeight: CGFloat = 778
        let topInset: CGFloat = 62
        let atRest = FeatureCommandDrawerGeometry.drawerOffset(
            reveal: 0, openHeight: openHeight, topInset: topInset
        )

        for reveal in stride(from: CGFloat(0), through: openHeight, by: 64) {
            let offset = FeatureCommandDrawerGeometry.drawerOffset(
                reveal: reveal, openHeight: openHeight, topInset: topInset
            )
            // All of the movement, and only the movement, is the drawer's.
            #expect(offset - atRest == reveal)
        }
    }

    @Test
    func theClosedDrawerHangsEntirelyAboveTheTopEdge() {
        let openHeight: CGFloat = 778
        let topInset: CGFloat = 62
        // The layer is `topInset + openHeight` tall and top-aligned in the page,
        // so its bottom edge is the offset plus its own height.
        let height = topInset + openHeight
        let closedBottom = FeatureCommandDrawerGeometry.drawerOffset(
            reveal: 0, openHeight: openHeight, topInset: topInset
        ) + height

        #expect(closedBottom == 0)
    }

    @Test
    func theOpenDrawersBottomEdgeAgreesWithTheOpenEdgeItAdvertises() {
        let windowHeight: CGFloat = 874
        let topInset: CGFloat = 62
        let bottomInset: CGFloat = 34
        let pageHeight = windowHeight - topInset - bottomInset
        let openHeight = FeatureCommandDrawerGeometry.openHeight(
            availableHeight: pageHeight,
            keyboardHeight: Self.keyboardHeight,
            bottomInset: bottomInset
        )
        let height = topInset + openHeight
        // Page-local bottom edge of the fully revealed drawer…
        let bottom = FeatureCommandDrawerGeometry.drawerOffset(
            reveal: openHeight, openHeight: openHeight, topInset: topInset
        ) + height
        // …converted to window coordinates must be the advertised open edge, so
        // removing the page's translation cannot have moved the drawer.
        #expect(bottom + topInset == FeatureCommandDrawerGeometry.openEdge(
            windowHeight: windowHeight,
            topInset: topInset,
            bottomInset: bottomInset,
            keyboardHeight: Self.keyboardHeight
        ))
    }

    // MARK: - Autofocus

    @Test
    func aSwipeThatSettlesBeforeTheFieldIsOnScreenStillGetsTheKeyboard() {
        // Test 91: the keyboard stopped coming up on its own. The request is
        // made at the start of the pull, when the search field is still above
        // the window's top edge and the request can be dropped; the long drag
        // of the rejected build hid that, and a quarter-second swipe does not.
        var state = FeatureCommandDrawerState()
        state.beginDrag()
        state.updateDrag(translation: 140, openHeight: 442)

        // Nothing to renew mid-pull: the initial request owns that window, and
        // renewing here would fight it.
        #expect(
            FeatureCommandDrawerFocus.needsFocusRenewal(state: state, isFocused: false) == false
        )

        state.endDrag(velocity: 0, openHeight: 442)
        #expect(state.isOpen)
        // The drawer has arrived and nothing took focus, so ask again.
        #expect(FeatureCommandDrawerFocus.needsFocusRenewal(state: state, isFocused: false))
        // …and stop asking the moment it lands, so the renewal cannot loop.
        #expect(
            FeatureCommandDrawerFocus.needsFocusRenewal(state: state, isFocused: true) == false
        )
    }

    @Test
    func aClosedDrawerNeverAsksForTheKeyboard() {
        var state = FeatureCommandDrawerState()
        #expect(
            FeatureCommandDrawerFocus.needsFocusRenewal(state: state, isFocused: false) == false
        )

        // An abandoned pull settles closed and must take the keyboard with it
        // rather than renewing a request behind a drawer nobody can see.
        state.beginDrag()
        state.updateDrag(translation: 40, openHeight: 442)
        state.endDrag(velocity: 0, openHeight: 442)
        #expect(state.isOpen == false)
        #expect(
            FeatureCommandDrawerFocus.needsFocusRenewal(state: state, isFocused: false) == false
        )

        state.settle(open: true, openHeight: 442)
        state.close()
        #expect(
            FeatureCommandDrawerFocus.needsFocusRenewal(state: state, isFocused: false) == false
        )
    }

    @Test
    func anyPathThatOpensTheDrawerAsksForTheKeyboard() {
        // Not only the swipe: a drawer opened without a drag at all must still
        // arrive focused.
        var state = FeatureCommandDrawerState()
        state.settle(open: true, openHeight: 442)

        #expect(FeatureCommandDrawerFocus.searchIsFocused(for: state))
        #expect(FeatureCommandDrawerFocus.needsFocusRenewal(state: state, isFocused: false))
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
    func releasingBeforeTheCommitDistanceSettlesClosedAndAfterItSettlesOpen() {
        let openHeight: CGFloat = 400
        let commit = FeatureCommandDrawerGeometry.commitDistance(openHeight: openHeight)
        #expect(commit == FeatureCommandDrawerGeometry.settleCommitDistance)

        #expect(
            FeatureCommandDrawerGeometry.settlesOpen(
                reveal: commit - 1,
                velocity: 0,
                openHeight: openHeight,
                wasOpen: false
            ) == false
        )
        #expect(
            FeatureCommandDrawerGeometry.settlesOpen(
                reveal: commit,
                velocity: 0,
                openHeight: openHeight,
                wasOpen: false
            )
        )
    }

    @Test
    func anOrdinarySwipeDownTheTopBarOpensTheFullPageDrawer() {
        // Issue #122. The drawer opens to the whole page, so a settle measured
        // as a fraction of the open height demanded a third of the screen of
        // travel: an ordinary swipe fell short and snapped shut, and the
        // palette could effectively only be opened by pressing and dragging.
        let openHeight = FeatureCommandDrawerGeometry.openHeight(availableHeight: 778)
        let swipe: CGFloat = 140

        #expect(
            FeatureCommandDrawerGeometry.settlesOpen(
                reveal: swipe,
                velocity: 0,
                openHeight: openHeight,
                wasOpen: false
            )
        )
        // The rejected rule: 40% of a full-page drawer is most of the reachable
        // screen, and this swipe is nowhere near it.
        #expect(swipe < openHeight * 0.4)

        // A brisk swipe that has barely started travelling still commits on the
        // speed it was thrown at.
        #expect(
            FeatureCommandDrawerGeometry.settlesOpen(
                reveal: 30,
                velocity: 900,
                openHeight: openHeight,
                wasOpen: false
            )
        )
    }

    @Test
    func aCommittedPullIsMeasuredFromTheRestPositionTheDragStartedAt() {
        let openHeight: CGFloat = 400
        let commit = FeatureCommandDrawerGeometry.commitDistance(openHeight: openHeight)

        // Closing takes the same short push back that opening took out, rather
        // than having to drag the drawer most of the way up again.
        #expect(
            FeatureCommandDrawerGeometry.settlesOpen(
                reveal: openHeight - commit,
                velocity: 0,
                openHeight: openHeight,
                wasOpen: true
            ) == false
        )
        // Barely moving an open drawer leaves it open.
        #expect(
            FeatureCommandDrawerGeometry.settlesOpen(
                reveal: openHeight - 20,
                velocity: 0,
                openHeight: openHeight,
                wasOpen: true
            )
        )
        // The same reveal settles the other way depending on where the drag
        // began, which is what makes an abandoned pull return to its own rest
        // position instead of jumping across the screen.
        let midway = openHeight / 2
        #expect(
            FeatureCommandDrawerGeometry.settlesOpen(
                reveal: midway, velocity: 0, openHeight: openHeight, wasOpen: true
            ) == false
        )
        #expect(
            FeatureCommandDrawerGeometry.settlesOpen(
                reveal: midway, velocity: 0, openHeight: openHeight, wasOpen: false
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
                velocity: 800,
                openHeight: openHeight,
                wasOpen: false
            )
        )
        // Upward flick from a nearly open drawer still closes.
        #expect(
            FeatureCommandDrawerGeometry.settlesOpen(
                reveal: 380,
                velocity: -1200,
                openHeight: openHeight,
                wasOpen: true
            ) == false
        )
        // An upward flick that is not enough to carry the drawer back past the
        // commit distance leaves it open.
        #expect(
            FeatureCommandDrawerGeometry.settlesOpen(
                reveal: 380,
                velocity: -200,
                openHeight: openHeight,
                wasOpen: true
            )
        )
        // A downward flick on a closed drawer that dies immediately does not
        // count as a swipe.
        #expect(
            FeatureCommandDrawerGeometry.settlesOpen(
                reveal: 10,
                velocity: 100,
                openHeight: openHeight,
                wasOpen: false
            ) == false
        )
    }

    @Test
    func theCommitDistanceNeverExceedsHalfOfAShortDrawer() {
        // The keyboard floor can make the drawer shorter than the ordinary
        // commit distance; both directions must still be reachable.
        let short = FeatureCommandDrawerGeometry.minimumOpenHeight
        let commit = FeatureCommandDrawerGeometry.commitDistance(openHeight: short)
        #expect(commit <= short / 2)

        #expect(
            FeatureCommandDrawerGeometry.settlesOpen(
                reveal: short / 2, velocity: 0, openHeight: short, wasOpen: false
            )
        )
        #expect(
            FeatureCommandDrawerGeometry.settlesOpen(
                reveal: short / 2, velocity: 0, openHeight: short, wasOpen: true
            ) == false
        )
        // No drawer to settle means nothing to open.
        #expect(
            FeatureCommandDrawerGeometry.settlesOpen(
                reveal: 300, velocity: 900, openHeight: 0, wasOpen: false
            ) == false
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
    func theGrabBandCoversEveryTopBarInTheAppWithoutReachingTheSystemsOwn() {
        // Issue #122: the same swipe has to work everywhere, so the band must
        // cover Home's own bar and the navigation bar the thread page and the
        // other pushed surfaces use — both of which start at the top inset.
        let topInset: CGFloat = 62
        let homeBarHeight: CGFloat = 49
        let navigationBarHeight: CGFloat = 44

        for barHeight in [homeBarHeight, navigationBarHeight] {
            for offset in stride(from: CGFloat(1), through: barHeight, by: 4) {
                #expect(
                    FeatureCommandDrawerGesture.canBeginTouch(
                        atY: topInset + offset, reveal: 0, topInset: topInset
                    )
                )
            }
        }

        // The status bar above the inset stays the system's: that is where the
        // notification shade is pulled from, and the app must not claim it.
        for y in stride(from: CGFloat(0), through: topInset - 1, by: 6) {
            #expect(
                FeatureCommandDrawerGesture.canBeginTouch(
                    atY: y, reveal: 0, topInset: topInset
                ) == false
            )
        }

        // Content below the bars keeps every ordinary scroll, on Home's thread
        // list and on the thread transcript alike.
        for y in stride(from: topInset + homeBarHeight + 64, through: 800, by: 40) {
            #expect(
                FeatureCommandDrawerGesture.canBeginTouch(
                    atY: y, reveal: 0, topInset: topInset
                ) == false
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
    func releasingBeforeTheCommitDistanceReturnsTheDrawerToTheClosedEdge() {
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
