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
        view.contentOffset.y = 2_250
        view.removeFromSuperview()
        controller.view.addSubview(view)
        view.layoutIfNeeded()
        #expect(view.contentOffset.y == 2_400)

        view.maintainsBottomAnchor = false
        view.contentOffset.y = 500
        view.layoutIfNeeded()
        view.removeFromSuperview()
        controller.view.addSubview(view)
        view.layoutIfNeeded()
        #expect(view.contentOffset.y == 500)
        #expect(!view.maintainsBottomAnchor)
        #expect(!button.isHidden)
        #expect(view.bounds.contains(button.frame))
        button.sendActions(for: .touchUpInside)
        #expect(view.contentOffset.y == 2_400)
        #expect(view.maintainsBottomAnchor)
        #expect(button.isHidden)

        view.setContentOffset(CGPoint(x: 0, y: 1_900), animated: false)
        view.layoutIfNeeded()
        #expect(view.contentOffset.y == 1_900)
        #expect(!view.maintainsBottomAnchor)
        button.sendActions(for: .touchUpInside)
        #expect(view.maintainsBottomAnchor)

        // New output glides instead of snapping; a viewport change still snaps.
        layout.height = 3_200
        layout.invalidateLayout()
        view.layoutIfNeeded()
        #expect(view.contentOffset.y == 2_400)
        #expect(view.maintainsBottomAnchor)
        #expect(button.isHidden)
        view.frame.size.height = 350
        view.layoutIfNeeded()
        #expect(view.contentOffset.y == 2_850)
        #expect(button.isHidden)
    }

    @Test
    @MainActor
    func reflowKeepsTheVisibleCharacterInsideOneLongMessage() throws {
        let viewport = UIScrollView(frame: CGRect(x: 0, y: 0, width: 400, height: 300))
        viewport.contentInsetAdjustmentBehavior = .never
        let cell = UIView()
        let text = UITextView()
        text.isScrollEnabled = false
        text.font = .systemFont(ofSize: 17)
        text.text = (0..<100).map { "Paragraph \($0): A long response wraps differently when the phone unfolds or rotates." }
            .joined(separator: "\n\n")
        cell.addSubview(text)
        viewport.addSubview(cell)
        func resize(_ width: CGFloat) {
            viewport.frame.size.width = width
            let height = text.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
            text.frame = CGRect(x: 0, y: 0, width: width, height: height)
            cell.frame = text.frame
            viewport.contentSize = cell.frame.size
            text.layoutIfNeeded()
        }
        resize(400)
        viewport.contentOffset.y = 700
        let position = try #require(text.closestPosition(to: CGPoint(x: text.textContainerInset.left, y: 700)))
        let character = text.offset(from: text.beginningOfDocument, to: position)
        let offset = text.convert(text.caretRect(for: position), to: viewport).minY - viewport.contentOffset.y
        let anchor = try #require(TranscriptTextAnchor.capture(in: cell, viewport: viewport))
        resize(200)
        viewport.contentOffset.y = try #require(anchor.targetOffset(in: cell, viewport: viewport))
        let sameCharacter = try #require(text.position(from: text.beginningOfDocument, offset: character))
        let newOffset = text.convert(text.caretRect(for: sameCharacter), to: viewport).minY - viewport.contentOffset.y
        #expect(abs(newOffset - offset) < 1)
        #expect(viewport.contentOffset.y > 1_000)
    }

    @Test
    @MainActor
    func widthChangesKeepTheSameMessageAtTheSameReadingPosition() {
        let layout = ReflowingTranscriptLayout()
        let view = BottomAnchoredTranscriptCollectionView(
            frame: CGRect(x: 0, y: 0, width: 390, height: 600), collectionViewLayout: layout
        )
        let dataSource = FixedTranscriptDataSource(count: 20)
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
        view.maintainsBottomAnchor = false
        view.contentOffset.y = 500
        view.layoutIfNeeded()

        // UIKit can repeat the current offset before starting a resize.
        // That must not discard the reading position from the last layout.
        view.setContentOffset(view.contentOffset, animated: false)

        view.frame.size.width = 195
        view.layoutIfNeeded()
        #expect(abs(view.contentOffset.y - 900) < 1)
        #expect(!view.maintainsBottomAnchor)

        layout.heightBeforeRows = 120
        layout.invalidateLayout()
        view.setNeedsLayout()
        view.layoutIfNeeded()
        #expect(abs(view.contentOffset.y - 1_020) < 1)

        view.frame.size.width = 390
        view.layoutIfNeeded()
        #expect(abs(view.contentOffset.y - 620) < 1)
        #expect(!view.maintainsBottomAnchor)

        layout.heightBeforeRows = 0
        layout.invalidateLayout()
        view.setNeedsLayout()
        view.layoutIfNeeded()
        #expect(abs(view.contentOffset.y - 500) < 1)

        // Keyboard, accessibility, and prepend restoration use this UIKit API
        // without a drag. A pending width anchor must yield to that scroll.
        view.setContentOffset(CGPoint(x: 0, y: 200), animated: false)
        view.setNeedsLayout()
        view.layoutIfNeeded()
        #expect(abs(view.contentOffset.y - 200) < 1)
        #expect(!view.maintainsBottomAnchor)
    }

    @Test @MainActor
    func readingAnchorSkipsUnmeasuredAndLoadEarlierRows() throws {
        // Scrolling up, a row first appears at its estimated height and grows
        // when measured; "Load earlier" is not a reading position. The anchor
        // must be the first measured message row so loading and measuring do
        // not move what the reader sees.
        let heights: [CGFloat] = [44, BottomAnchoredTranscriptCollectionView.estimatedRowHeight, 300, 300]
        let ids = ["__t3-load-earlier__", "unmeasured", "message-a", "message-b"]
        let layout = StackedTranscriptLayout(heights: heights)
        let view = BottomAnchoredTranscriptCollectionView(
            frame: CGRect(x: 0, y: 0, width: 390, height: 600), collectionViewLayout: layout
        )
        let dataSource = FixedTranscriptDataSource(count: heights.count)
        defer { withExtendedLifetime(dataSource) {} }
        view.register(UICollectionViewCell.self, forCellWithReuseIdentifier: "message")
        view.dataSource = dataSource
        view.contentInsetAdjustmentBehavior = .never
        view.readerItemID = { ids[$0.item] }
        view.readerIndexPath = { ids.firstIndex(of: $0).map { IndexPath(item: $0, section: 0) } }
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 800))
        window.addSubview(view)
        window.isHidden = false
        defer { window.isHidden = true }
        view.maintainsBottomAnchor = false
        view.layoutIfNeeded()
        view.contentOffset.y = 0
        view.layoutIfNeeded()

        let anchor = try #require(view.firstVisibleItem())
        #expect(anchor.itemID == "message-a")

        // The unmeasured row grows when measured: message-a stays put.
        layout.heights = [44, 520, 300, 300]
        layout.invalidateLayout()
        view.layoutIfNeeded()
        view.keepOnScreen(anchor)
        let attributes = try #require(view.collectionViewLayout.layoutAttributesForItem(at: IndexPath(item: 2, section: 0)))
        #expect(abs(attributes.frame.minY - view.contentOffset.y - anchor.minYInViewport) < 0.5)
    }

    @Test
    func glideReachesNewOutputAtTheSameSpeedOnAnyDisplay() {
        func glide(fps: Double, duration: Double, velocity: CGFloat = 0) -> (offset: CGFloat, velocity: CGFloat) {
            var state = (offset: CGFloat(0), velocity: velocity)
            for _ in 0..<Int(fps * duration) {
                state = TranscriptViewportGeometry.glideStep(
                    from: state.offset, velocity: state.velocity, to: 300, elapsed: 1 / fps
                )
            }
            return state
        }
        #expect(abs(glide(fps: 60, duration: 0.2).offset - glide(fps: 120, duration: 0.2).offset) < 1)
        #expect(glide(fps: 120, duration: 0.3).offset > 270)
        // Eases in: the first frame of a new chunk moves only a few points.
        #expect(glide(fps: 60, duration: 1 / 60).offset < 20)
        // A glide already in motion keeps its speed instead of restarting.
        #expect(glide(fps: 60, duration: 1 / 60, velocity: 2_000).offset > 25)
        #expect(glide(fps: 60, duration: 1) == (300, 0))
        #expect(glide(fps: 60, duration: 0.2).offset <= 300)
    }

    @Test
    func onlyContentChangesGlide() {
        let before = TranscriptViewportGeometry(contentHeight: 1_200, viewportHeight: 700, topInset: 0, bottomInset: 0)
        let grown = TranscriptViewportGeometry(contentHeight: 1_300, viewportHeight: 700, topInset: 0, bottomInset: 0)
        let keyboard = TranscriptViewportGeometry(contentHeight: 1_300, viewportHeight: 700, topInset: 0, bottomInset: 300)
        let empty = TranscriptViewportGeometry(contentHeight: 0, viewportHeight: 700, topInset: 0, bottomInset: 0)
        #expect(grown.glidesToBottom(after: before))
        #expect(!keyboard.glidesToBottom(after: before))
        #expect(!grown.glidesToBottom(after: empty))
        #expect(!grown.glidesToBottom(after: nil))
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
    let count: Int
    init(count: Int = 1) { self.count = count }
    func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int { count }
    func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
        collectionView.dequeueReusableCell(withReuseIdentifier: "message", for: indexPath)
    }
}

@MainActor
private final class StackedTranscriptLayout: UICollectionViewLayout {
    var heights: [CGFloat]
    init(heights: [CGFloat]) {
        self.heights = heights
        super.init()
    }

    required init?(coder: NSCoder) { nil }

    override var collectionViewContentSize: CGSize {
        CGSize(width: 390, height: heights.reduce(0, +))
    }

    override func layoutAttributesForItem(at indexPath: IndexPath) -> UICollectionViewLayoutAttributes? {
        guard heights.indices.contains(indexPath.item) else { return nil }
        let attributes = UICollectionViewLayoutAttributes(forCellWith: indexPath)
        let y = heights.prefix(indexPath.item).reduce(0, +)
        attributes.frame = CGRect(x: 0, y: y, width: 390, height: heights[indexPath.item])
        return attributes
    }

    override func layoutAttributesForElements(in rect: CGRect) -> [UICollectionViewLayoutAttributes]? {
        heights.indices.compactMap { layoutAttributesForItem(at: IndexPath(item: $0, section: 0)) }
            .filter { $0.frame.intersects(rect) }
    }
}

@MainActor
private final class ReflowingTranscriptLayout: UICollectionViewLayout {
    var heightBeforeRows: CGFloat = 0
    private var rowHeight: CGFloat { 78_000 / max(1, collectionView?.bounds.width ?? 390) }

    override var collectionViewContentSize: CGSize {
        CGSize(width: collectionView?.bounds.width ?? 390, height: rowHeight * 20 + heightBeforeRows)
    }

    override func shouldInvalidateLayout(forBoundsChange newBounds: CGRect) -> Bool {
        newBounds.width != collectionView?.bounds.width
    }

    override func layoutAttributesForItem(at indexPath: IndexPath) -> UICollectionViewLayoutAttributes? {
        let attributes = UICollectionViewLayoutAttributes(forCellWith: indexPath)
        attributes.frame = CGRect(x: 0, y: CGFloat(indexPath.item) * rowHeight + heightBeforeRows,
                                  width: collectionView?.bounds.width ?? 390, height: rowHeight)
        return attributes
    }

    override func layoutAttributesForElements(in rect: CGRect) -> [UICollectionViewLayoutAttributes]? {
        (0..<20).compactMap { layoutAttributesForItem(at: IndexPath(item: $0, section: 0)) }
            .filter { $0.frame.intersects(rect) }
    }
}
