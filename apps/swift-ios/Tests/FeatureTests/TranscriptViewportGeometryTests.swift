import CoreGraphics
import SwiftUI
import Testing
import UIKit
@testable import T3Code

@Suite("Transcript viewport and timestamp gestures")
struct TranscriptViewportGeometryTests {
    @Test
    func timestampRevealMovesTheVisibleTranscriptAsOneSheetAndResetsOnRelease() {
        var reveal = TranscriptTimestampRevealModel()

        reveal.begin(anchorYsByMessageID: [:])
        #expect(!reveal.isActive)
        reveal.update(translationX: -32)
        #expect(reveal == TranscriptTimestampRevealModel())

        reveal.begin(
            anchorYsByMessageID: [
                "assistant-1": 140,
                "assistant-2": 72,
                "user-1": 44,
            ]
        )
        reveal.update(translationX: -32)
        #expect(reveal.isActive)
        #expect(reveal.width == 32)
        #expect(reveal.anchorY(for: "assistant-1") == 140)
        #expect(reveal.anchorY(for: "assistant-2") == 72)
        #expect(reveal.anchorY(for: "user-1") == 44)
        #expect(reveal.anchorY(for: "offscreen-assistant") == nil)

        reveal.refresh(
            anchorYsByMessageID: [
                "assistant-2": 80,
                "newly-completed-assistant": 12,
            ]
        )
        #expect(reveal.width == 32)
        #expect(reveal.anchorY(for: "assistant-1") == nil)
        #expect(reveal.anchorY(for: "assistant-2") == 80)
        #expect(reveal.anchorY(for: "newly-completed-assistant") == 12)

        reveal.refresh(anchorYsByMessageID: [:])
        #expect(reveal.isActive)
        #expect(reveal.anchorY(for: "assistant-2") == 80)
        #expect(reveal.hasAnchor { $0 == "assistant-2" })
        #expect(!reveal.hasAnchor { $0 == "removed-message" })

        reveal.finish()
        #expect(reveal == TranscriptTimestampRevealModel())
        reveal.refresh(anchorYsByMessageID: ["late-assistant": 24])
        #expect(reveal == TranscriptTimestampRevealModel())
    }

    @Test
    func timestampDismissalHoldsAnchorsUntilItSettles() {
        var reveal = TranscriptTimestampRevealModel()

        reveal.begin(anchorYsByMessageID: ["assistant-1": 140, "user-1": 44])
        reveal.update(translationX: -60)
        #expect(reveal.width == 60)

        // Releasing zeroes the width inside the same animation that slides the
        // sheet back, but the anchors must survive it: they are what keeps each
        // timestamp vertically in place, and they also keep the reveal active so
        // the transcript does not re-anchor its scroll position mid-dismissal.
        reveal.beginDismissal()
        #expect(reveal.width == 0)
        #expect(reveal.isActive)
        #expect(reveal.anchorY(for: "assistant-1") == 140)
        #expect(reveal.anchorY(for: "user-1") == 44)

        reveal.finish()
        #expect(reveal == TranscriptTimestampRevealModel())
    }

    @Test
    @MainActor
    func completingAStreamedMessageKeepsItsRenderedMarkdownView() async throws {
        let source = "Distinctive streamed paragraph that completes mid-reveal."
        // Seed the cache so the streaming row already renders blocks instead of
        // falling back to plain text, giving the hosted text view an identity to
        // compare across the streaming -> complete transition.
        _ = MarkdownRenderCache.shared.documentImmediately(
            for: MarkdownContentRevision(source)
        )
        let sentAt = Date(timeIntervalSince1970: 1_780_000_000)
        let message = MessageTransitionHarness.MessageBox(
            FeatureMessage(
                id: "assistant-1",
                role: .assistant,
                text: source,
                createdAt: sentAt,
                state: .streaming
            )
        )
        let reveal = FeatureTimestampRevealState()
        let controller = UIHostingController(
            rootView: MessageTransitionHarness(
                message: message,
                reveal: reveal
            )
        )
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 402, height: 300))
        window.rootViewController = controller
        window.isHidden = false
        defer { window.isHidden = true }

        let streamingTextView = try #require(
            await awaitedTextView(in: controller.view, containing: "Distinctive streamed")
        )

        // Control: republishing the same streamed state must be a no-op for
        // identity, otherwise the harness itself is rebuilding the tree.
        message.send()
        let restreamedTextView = try #require(
            await awaitedTextView(in: controller.view, containing: "Distinctive streamed")
        )
        #expect(
            ObjectIdentifier(streamingTextView) == ObjectIdentifier(restreamedTextView),
            "Republishing the same streamed state rebuilt the markdown view"
        )

        message.value.state = .complete
        #expect(FeatureMessageTimestampMetadata.isEligible(message.value))
        message.send()

        // Completing the stream flips eligibility, which is what decides whether
        // the reveal overlay is attached. The message view underneath must keep
        // its identity so the streamed render and any active selection survive.
        let completedTextView = try #require(
            await awaitedTextView(in: controller.view, containing: "Distinctive streamed")
        )
        #expect(
            ObjectIdentifier(streamingTextView) == ObjectIdentifier(completedTextView),
            "Completing a streamed message rebuilt its markdown view instead of reusing it"
        )
    }

    @Test
    @MainActor
    func revealReleaseSettlesAndReportsBackToTheTranscript() async throws {
        let reveal = FeatureTimestampRevealState()
        reveal.begin(anchorYsByMessageID: ["assistant-1": 140])
        reveal.update(translationX: -60)
        #expect(reveal.isActive)

        var settledReduceMotion = 0
        reveal.release(reduceMotion: true) { settledReduceMotion += 1 }
        #expect(settledReduceMotion == 1)
        #expect(!reveal.isActive)
        #expect(reveal.anchorY(for: "assistant-1") == nil)

        // The animated slide-back must also land: a reveal that never settles
        // would keep the transcript pinned to the reveal layout forever.
        reveal.begin(anchorYsByMessageID: ["assistant-2": 72])
        reveal.update(translationX: -40)
        var settledAnimated = 0
        reveal.release(reduceMotion: false) { settledAnimated += 1 }
        for _ in 0..<200 where settledAnimated == 0 {
            await Task.yield()
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(settledAnimated == 1)
        #expect(!reveal.isActive)

        // A fresh gesture right after a release must find a clean, working reveal.
        reveal.begin(anchorYsByMessageID: ["user-1": 30])
        reveal.update(translationX: -40)
        var settledAgain = 0
        reveal.release(reduceMotion: false) { settledAgain += 1 }
        for _ in 0..<200 where settledAgain == 0 {
            await Task.yield()
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(settledAgain == 1)

        reveal.begin(anchorYsByMessageID: ["user-2": 60])
        reveal.update(translationX: -50)
        #expect(reveal.isActive)
        #expect(reveal.width == 50)
        #expect(reveal.anchorY(for: "user-2") == 60)
    }

    @Test
    func timestampAnchorClampsInsideItsMessageRow() {
        #expect(
            TranscriptTimestampRevealGeometry.anchorCenterY(
                requestedY: 1_240,
                rowHeight: 4_000
            ) == 1_240
        )
        #expect(
            TranscriptTimestampRevealGeometry.anchorCenterY(
                requestedY: -20,
                rowHeight: 4_000
            ) == TranscriptTimestampRevealGeometry.minimumAnchorInset
        )
        #expect(
            TranscriptTimestampRevealGeometry.anchorCenterY(
                requestedY: 4_020,
                rowHeight: 4_000
            ) == 4_000 - TranscriptTimestampRevealGeometry.minimumAnchorInset
        )
        #expect(
            TranscriptTimestampRevealGeometry.anchorCenterY(
                requestedY: 12,
                rowHeight: 24
            ) == 12
        )
        #expect(
            TranscriptTimestampRevealGeometry.resolvedAnchorCenterY(
                requestedY: 5,
                rowHeight: 200
            ) == 5
        )
        #expect(
            TranscriptTimestampRevealGeometry.resolvedAnchorCenterY(
                requestedY: 887,
                rowHeight: 905
            ) == 887
        )
        #expect(
            TranscriptTimestampRevealGeometry.resolvedAnchorCenterY(
                requestedY: nil,
                rowHeight: 200
            ) == 100
        )
    }

    @Test
    func timestampAnchorsEveryVisibleRowInsideItsVisibleViewportSlice() {
        let viewport = CGRect(x: 0, y: 1_000, width: 440, height: 700)

        #expect(
            TranscriptTimestampRevealGeometry.visibleAnchorCenterY(
                rowFrame: CGRect(x: 18, y: 900, width: 404, height: 400),
                viewportBounds: viewport
            ) == 250
        )
        #expect(
            TranscriptTimestampRevealGeometry.visibleAnchorCenterY(
                rowFrame: CGRect(x: 18, y: 1_340, width: 404, height: 100),
                viewportBounds: viewport
            ) == 50
        )
        #expect(
            TranscriptTimestampRevealGeometry.visibleAnchorCenterY(
                rowFrame: CGRect(x: 18, y: 800, width: 404, height: 1_100),
                viewportBounds: viewport
            ) == 550
        )
        #expect(
            TranscriptTimestampRevealGeometry.visibleAnchorCenterY(
                rowFrame: CGRect(x: 18, y: 1_690, width: 404, height: 200),
                viewportBounds: viewport
            ) == 5
        )
        #expect(
            TranscriptTimestampRevealGeometry.visibleAnchorCenterY(
                rowFrame: CGRect(x: 18, y: 1_700, width: 404, height: 100),
                viewportBounds: viewport
            ) == nil
        )
        #expect(
            TranscriptTimestampRevealGeometry.visibleAnchorCenterY(
                rowFrame: CGRect(x: 18, y: 1_800, width: 404, height: 100),
                viewportBounds: viewport
            ) == nil
        )
        #expect(
            TranscriptTimestampRevealGeometry.visibleAnchorCenterY(
                rowFrame: CGRect(x: 18, y: 800, width: 404, height: 100),
                viewportBounds: viewport
            ) == nil
        )
    }

    @Test
    func timestampRevealClampsAndClaimsOnlyDeliberateLeftwardHorizontalPans() {
        #expect(TranscriptTimestampRevealGeometry.width(translationX: 24) == 0)
        #expect(
            TranscriptTimestampRevealGeometry.width(translationX: -200)
                == TranscriptTimestampRevealGeometry.maximumWidth
        )
        #expect(
            TranscriptTimestampRevealGeometry.shouldBegin(velocityX: -24, velocityY: 4)
        )
        #expect(
            !TranscriptTimestampRevealGeometry.shouldBegin(velocityX: -4, velocityY: 24)
        )
        #expect(
            !TranscriptTimestampRevealGeometry.shouldBegin(velocityX: 24, velocityY: 4)
        )
        #expect(
            !TranscriptTimestampRevealGeometry.shouldBegin(velocityX: -10, velocityY: 9)
        )
    }

    @Test
    func timestampEligibilityRequiresCompletedUserOrAssistantWithRealDate() {
        let timestamp = Date(timeIntervalSince1970: 1_780_000_000)

        #expect(
            FeatureMessageTimestampMetadata.isEligible(
                role: .user,
                state: .complete,
                createdAt: timestamp
            )
        )
        #expect(
            FeatureMessageTimestampMetadata.isEligible(
                role: .assistant,
                state: .complete,
                createdAt: timestamp
            )
        )
        for state in [FeatureMessageState.queued, .streaming, .failed] {
            #expect(
                !FeatureMessageTimestampMetadata.isEligible(
                    role: .assistant,
                    state: state,
                    createdAt: timestamp
                )
            )
        }
        for role in [FeatureMessageRole.tool, .system] {
            #expect(
                !FeatureMessageTimestampMetadata.isEligible(
                    role: role,
                    state: .complete,
                    createdAt: timestamp
                )
            )
        }
        #expect(
            !FeatureMessageTimestampMetadata.isEligible(
                role: .user,
                state: .complete,
                createdAt: .distantPast
            )
        )
    }

    @Test
    func timestampAccessibilityLabelsOnlyEligibleConversationRoles() {
        #expect(FeatureMessageTimestampMetadata.accessibilityLabel(for: .user) == "Sent")
        #expect(FeatureMessageTimestampMetadata.accessibilityLabel(for: .assistant) == "Received")
        #expect(FeatureMessageTimestampMetadata.accessibilityLabel(for: .tool) == nil)
        #expect(FeatureMessageTimestampMetadata.accessibilityLabel(for: .system) == nil)
    }

    @Test
    @MainActor
    func selectableMarkdownDoesNotStealTimestampSwipeButHorizontalContentDoes() {
        let host = UIView(frame: CGRect(x: 0, y: 0, width: 240, height: 240))
        let textView = UITextView(frame: CGRect(x: 0, y: 0, width: 120, height: 120))
        textView.contentSize = CGSize(width: 480, height: 120)
        host.addSubview(textView)

        #expect(
            !TranscriptTimestampGestureOwnership.descendantOwnsHorizontalInteraction(
                from: textView,
                host: host
            )
        )

        let codeScroller = UIScrollView(frame: CGRect(x: 0, y: 120, width: 120, height: 120))
        codeScroller.contentSize = CGSize(width: 480, height: 120)
        host.addSubview(codeScroller)
        #expect(
            TranscriptTimestampGestureOwnership.descendantOwnsHorizontalInteraction(
                from: codeScroller,
                host: host
            )
        )
    }

    @Test
    func firstLoadedTranscriptAnchorsToLatestMessage() {
        let empty = TranscriptViewportGeometry(
            contentHeight: 0,
            viewportHeight: 700,
            topInset: 0,
            bottomInset: 0
        )
        let loaded = TranscriptViewportGeometry(
            contentHeight: 1_200,
            viewportHeight: 700,
            topInset: 0,
            bottomInset: 0
        )

        #expect(
            loaded.restoredBottomOffset(
                after: empty,
                maintainsBottomAnchor: true,
                isInteracting: false
            ) == 500
        )
    }

    @Test
    func keyboardViewportChangeKeepsLatestMessageVisible() {
        let beforeKeyboard = TranscriptViewportGeometry(
            contentHeight: 1_200,
            viewportHeight: 700,
            topInset: 0,
            bottomInset: 0
        )
        let afterKeyboard = TranscriptViewportGeometry(
            contentHeight: 1_200,
            viewportHeight: 400,
            topInset: 0,
            bottomInset: 0
        )

        #expect(
            afterKeyboard.restoredBottomOffset(
                after: beforeKeyboard,
                maintainsBottomAnchor: true,
                isInteracting: false
            ) == 800
        )
    }

    @Test
    func readerPositionIsUntouchedAwayFromLatestMessage() {
        let beforeKeyboard = TranscriptViewportGeometry(
            contentHeight: 1_200,
            viewportHeight: 700,
            topInset: 0,
            bottomInset: 0
        )
        let afterKeyboard = TranscriptViewportGeometry(
            contentHeight: 1_200,
            viewportHeight: 400,
            topInset: 0,
            bottomInset: 0
        )

        #expect(
            afterKeyboard.restoredBottomOffset(
                after: beforeKeyboard,
                maintainsBottomAnchor: false,
                isInteracting: false
            ) == nil
        )
    }

    @Test
    func activeTranscriptGestureOwnsItsScrollPosition() {
        let before = TranscriptViewportGeometry(
            contentHeight: 1_200,
            viewportHeight: 700,
            topInset: 0,
            bottomInset: 0
        )
        let after = TranscriptViewportGeometry(
            contentHeight: 1_260,
            viewportHeight: 700,
            topInset: 0,
            bottomInset: 0
        )

        #expect(
            after.restoredBottomOffset(
                after: before,
                maintainsBottomAnchor: true,
                isInteracting: true
            ) == nil
        )
        #expect(
            TranscriptViewportGeometry.shouldMaintainBottomAnchor(
                isInitialLoad: false,
                wasNearBottom: false,
                isTimestampRevealActive: true,
                wasMaintainingBottomAnchor: true
            )
        )
        #expect(
            !TranscriptViewportGeometry.shouldMaintainBottomAnchor(
                isInitialLoad: false,
                wasNearBottom: false,
                isTimestampRevealActive: false,
                wasMaintainingBottomAnchor: true
            )
        )
    }

    @Test
    func verticalPanFailsBeforeItCanCompeteWithTranscriptScrolling() {
        #expect(!ThreadBackSwipeGesture.shouldBegin(with: CGPoint(x: 40, y: 120)))
        #expect(!ThreadBackSwipeGesture.shouldBegin(with: CGPoint(x: -120, y: 0)))
    }

    @Test
    func horizontalPanCanLeaveTheThreadFromAnywhereOnTheSurface() {
        #expect(ThreadBackSwipeGesture.shouldBegin(with: CGPoint(x: 120, y: 20)))
        #expect(
            ThreadBackSwipeGesture.shouldNavigateBack(
                with: CGPoint(x: 96, y: 16)
            )
        )
    }

    @Test
    func slowHorizontalPanUsesTranslationWhenVelocityIsUnavailable() {
        #expect(
            ThreadBackSwipeGesture.shouldBegin(
                with: .zero,
                translation: CGPoint(x: 16, y: 2)
            )
        )
        #expect(
            !ThreadBackSwipeGesture.shouldBegin(
                with: .zero,
                translation: CGPoint(x: 4, y: 16)
            )
        )
    }

    @Test
    func shortOrDiagonalPanDoesNotLeaveTheThread() {
        #expect(
            !ThreadBackSwipeGesture.shouldNavigateBack(
                with: CGPoint(x: 71, y: 0)
            )
        )
        #expect(
            !ThreadBackSwipeGesture.shouldNavigateBack(
                with: CGPoint(x: 96, y: 80)
            )
        )
    }

    @Test
    @MainActor
    func horizontalScrollContentSharesOnlyAtItsLeadingEdge() {
        let transcript = UIScrollView(frame: CGRect(x: 0, y: 0, width: 120, height: 120))
        transcript.contentSize = CGSize(width: 120, height: 480)
        #expect(ThreadBackSwipeGesture.shouldAllowSimultaneousRecognition(with: transcript))

        let codeBlock = UIScrollView(frame: CGRect(x: 0, y: 0, width: 120, height: 120))
        codeBlock.contentSize = CGSize(width: 480, height: 120)
        codeBlock.alwaysBounceVertical = true
        #expect(ThreadBackSwipeGesture.shouldAllowSimultaneousRecognition(with: codeBlock))
        codeBlock.contentOffset = CGPoint(x: 100, y: 0)
        #expect(!ThreadBackSwipeGesture.shouldAllowSimultaneousRecognition(with: codeBlock))
    }

    @Test
    @MainActor
    func horizontalScrollAncestorsCanReceiveBackPanAtLeadingEdge() {
        let host = UIView(frame: CGRect(x: 0, y: 0, width: 240, height: 240))
        let codeBlock = UIScrollView(frame: host.bounds)
        codeBlock.contentSize = CGSize(width: 480, height: 240)
        let label = UILabel(frame: .zero)
        codeBlock.addSubview(label)
        host.addSubview(codeBlock)

        #expect(ThreadBackSwipeGesture.shouldReceiveTouch(in: label, host: host))
        codeBlock.contentOffset = CGPoint(x: 100, y: 0)
        #expect(!ThreadBackSwipeGesture.shouldReceiveTouch(in: label, host: host))
        #expect(ThreadBackSwipeGesture.shouldReceiveTouch(in: host, host: host))

        let detachedHost = UIView(frame: host.bounds)
        let detachedCodeBlock = UIScrollView(frame: detachedHost.bounds)
        detachedCodeBlock.contentSize = CGSize(width: 480, height: 240)
        let detachedLabel = UILabel(frame: .zero)
        detachedCodeBlock.addSubview(detachedLabel)
        detachedHost.addSubview(detachedCodeBlock)
        #expect(!ThreadBackSwipeGesture.shouldReceiveTouch(in: detachedLabel, host: host))
    }

    @Test
    @MainActor
    func activeTextInteractionsKeepHorizontalDrags() {
        let host = UIView(frame: CGRect(x: 0, y: 0, width: 240, height: 240))
        let textField = UITextField(frame: .zero)
        let textView = UITextView(frame: .zero)
        textView.text = "Selectable transcript text"
        let textViewContent = UIView(frame: .zero)
        textView.addSubview(textViewContent)
        host.addSubview(textField)
        host.addSubview(textView)

        #expect(!ThreadBackSwipeGesture.shouldReceiveTouch(in: textField, host: host))
        textView.isEditable = false
        #expect(ThreadBackSwipeGesture.shouldReceiveTouch(in: textView, host: host))
        #expect(ThreadBackSwipeGesture.shouldReceiveTouch(in: textViewContent, host: host))

        textView.selectedRange = NSRange(location: 0, length: 1)
        #expect(ThreadBackSwipeGesture.shouldReceiveTouch(in: textView, host: host))
        #expect(ThreadBackSwipeGesture.shouldReceiveTouch(in: textViewContent, host: host))

        textView.selectedRange = NSRange(location: 0, length: 0)
        textView.isEditable = true
        #expect(!ThreadBackSwipeGesture.shouldReceiveTouch(in: textView, host: host))

        let window = UIWindow(frame: host.bounds)
        let rootViewController = UIViewController()
        window.rootViewController = rootViewController
        rootViewController.view.addSubview(host)
        window.makeKeyAndVisible()
        textView.isEditable = false
        #expect(textView.becomeFirstResponder())
        #expect(!ThreadBackSwipeGesture.shouldReceiveTouch(in: textViewContent, host: host))
        textView.resignFirstResponder()
        window.isHidden = true

        #expect(ThreadBackSwipeGesture.shouldReceiveTouch(in: host, host: host))
    }
}

@MainActor
private func awaitedTextView(
    in host: UIView,
    containing fragment: String
) async -> UITextView? {
    for _ in 0..<30 {
        host.setNeedsLayout()
        host.layoutIfNeeded()
        if let match = textViews(in: host).first(where: { $0.text.contains(fragment) }) {
            return match
        }
        try? await Task.sleep(for: .milliseconds(10))
    }
    return nil
}

@MainActor
private func textViews(in view: UIView) -> [UITextView] {
    view.subviews.reduce(into: []) { found, subview in
        if let textView = subview as? UITextView {
            found.append(textView)
        }
        found.append(contentsOf: textViews(in: subview))
    }
}

/// Publishes the message the way the transcript does: the same hosted view
/// position receives a new message value, so identity survives or breaks on the
/// strength of the view structure alone.
@MainActor
private struct MessageTransitionHarness: View {
    @MainActor
    final class MessageBox: ObservableObject {
        @Published var value: FeatureMessage

        init(_ value: FeatureMessage) {
            self.value = value
        }

        func send() {
            let current = value
            value = current
        }
    }

    @ObservedObject var message: MessageBox
    @ObservedObject var reveal: FeatureTimestampRevealState

    var body: some View {
        FeatureTimestampRevealMessageView(
            message: message.value,
            imageContext: nil,
            reveal: reveal
        )
    }
}
