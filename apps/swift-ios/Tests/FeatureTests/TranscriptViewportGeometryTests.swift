import CoreGraphics
import Testing
import UIKit
@testable import T3Code

@Suite("Transcript viewport anchoring")
struct TranscriptViewportGeometryTests {
    @Test func bottomButtonUsesTheVisibleViewportIncludingKeyboardInsets() {
        let geometry = TranscriptViewportGeometry(contentHeight: 1_200, viewportHeight: 400, topInset: 20, bottomInset: 100)
        #expect(geometry.showsScrollToBottom(at: 780))
        #expect(!geometry.showsScrollToBottom(at: 781))
        #expect(!geometry.showsScrollToBottom(at: 900))
        let short = TranscriptViewportGeometry(contentHeight: 100, viewportHeight: 400, topInset: 20, bottomInset: 0)
        #expect(!short.showsScrollToBottom(at: -20))
    }

    @Test @MainActor
    func transcriptOpensAtBottomAndButtonRestoresFollowing() throws {
        let layout = FixedTranscriptLayout()
        let view = BottomAnchoredTranscriptCollectionView(frame: .zero, collectionViewLayout: layout)
        let dataSource = FixedTranscriptDataSource()
        defer { withExtendedLifetime(dataSource) {} }
        view.register(UICollectionViewCell.self, forCellWithReuseIdentifier: "message")
        view.dataSource = dataSource
        view.contentInsetAdjustmentBehavior = .never
        let controller = UIViewController()
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 800))
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        controller.view.addSubview(view)
        view.layoutIfNeeded()
        // The first snapshot can arrive before the destination has its final size.
        layout.height = 3_000
        view.reloadData()
        layout.invalidateLayout()
        view.frame = CGRect(x: 0, y: 0, width: 390, height: 600)
        view.layoutIfNeeded()
        #expect(view.contentOffset.y == 2_400)
        let button = try #require(view.subviews.compactMap { $0 as? UIButton }.first)
        #expect(button.isHidden)

        view.maintainsBottomAnchor = false
        view.contentOffset.y = 500
        view.layoutIfNeeded()
        #expect(!button.isHidden)
        #expect(view.bounds.contains(button.frame))
        button.sendActions(for: .touchUpInside)
        #expect(view.contentOffset.y == 2_400)
        #expect(view.maintainsBottomAnchor)
        #expect(button.isHidden)

        layout.height = 3_200
        layout.invalidateLayout()
        view.layoutIfNeeded()
        #expect(view.contentOffset.y == 2_600)
        view.frame.size.height = 350
        view.layoutIfNeeded()
        #expect(view.contentOffset.y == 2_850)
        #expect(button.isHidden)
    }

    @Test
    func transcriptPrefetchUsesTheVisibleSnapshotWhenLoadEarlierIsPresent() {
        let ids = TranscriptPrefetchIdentity.messageIDs(
            at: [IndexPath(item: 1, section: 0), IndexPath(item: 2, section: 0)],
            snapshotItemIDs: ["__t3-load-earlier__", "message-1", "message-2"],
            reservedItemIDs: ["__t3-load-earlier__", "__t3-working-indicator__"]
        )

        #expect(ids == ["message-1", "message-2"])
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
private final class FixedTranscriptLayout: UICollectionViewLayout {
    var height: CGFloat = 0
    override var collectionViewContentSize: CGSize { CGSize(width: 390, height: height) }
    override func layoutAttributesForItem(at indexPath: IndexPath) -> UICollectionViewLayoutAttributes? {
        let attributes = UICollectionViewLayoutAttributes(forCellWith: indexPath)
        attributes.frame = CGRect(x: 0, y: 0, width: 390, height: height)
        return attributes
    }
    override func layoutAttributesForElements(in rect: CGRect) -> [UICollectionViewLayoutAttributes]? {
        [layoutAttributesForItem(at: IndexPath(item: 0, section: 0))!]
    }
}

@MainActor
private final class FixedTranscriptDataSource: NSObject, UICollectionViewDataSource {
    func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int { 1 }
    func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
        collectionView.dequeueReusableCell(withReuseIdentifier: "message", for: indexPath)
    }
}
