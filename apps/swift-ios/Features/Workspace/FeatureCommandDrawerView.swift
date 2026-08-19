import SwiftUI
import UIKit

/// Hosts the workspace inside a physical top drawer.
///
/// The drawer hangs above the top edge; pulling it down moves the drawer, the
/// scrim, and the whole page together with the finger, and releasing settles
/// both to the same rest position. Nothing here presents a sheet, so the
/// palette can never animate up from the bottom while the finger travels down.
struct FeatureCommandDrawerContainer<Content: View>: View {
    @SwiftUI.Environment(\.accessibilityReduceMotion) private var reduceMotion

    @Binding var state: FeatureCommandDrawerState
    @Binding var query: String
    let items: [FeatureCommandDrawerItem]
    let onSelect: (FeatureCommandDrawerItem) -> Void
    @ViewBuilder let content: Content

    @FocusState private var isQueryFocused: Bool

    /// Measured in the drawer layer, which is the only place that needs
    /// geometry. The workspace itself stays in its normal layout path: wrapping
    /// a `NavigationSplitView` in a `GeometryReader` changes how it resolves its
    /// own columns and safe areas, so the drawer never does that.
    @State private var openHeight: CGFloat = 0
    /// Height the software keyboard currently covers, so the drawer can rest
    /// exactly on top of it instead of hiding behind it.
    @State private var keyboardHeight: CGFloat = 0

    var body: some View {
        // The page is deliberately not offset. The drawer is presented over the
        // workspace, so the rows, header and composer underneath stay exactly
        // where they were and only the drawer and its scrim move with the
        // finger. Translating the page as well read as the whole screen being
        // shoved downwards, which is not what a drawer does.
        content
            .overlay {
                scrim(progress: progress)
            }
            .overlay(alignment: .top) {
                drawerLayer
            }
            .background {
                FeatureCommandDrawerGestureView(
                    reveal: state.reveal,
                    isOpen: state.isOpen,
                    onBegan: { state.beginDrag() },
                    onChanged: { translation in
                        state.updateDrag(translation: translation, openHeight: openHeight)
                    },
                    onEnded: { velocity in
                        settle(velocity: velocity, openHeight: openHeight)
                    },
                    onCancelled: {
                        withAnimation(settleAnimation) { state.cancelDrag(openHeight: openHeight) }
                    }
                )
            }
            // Focus follows presentation: the keyboard rises with the drawer so
            // typing is instant, and the drawer's open height already accounts
            // for it before the drag is released.
            .onChange(of: state.isVisible) { _, isVisible in
                isQueryFocused = FeatureCommandDrawerFocus.searchIsFocused(for: state)
                if !isVisible {
                    query = ""
                    resignKeyboard()
                }
            }
            // …but the request above is made while the field is still above the
            // window's top edge, where it can be dropped. Renew it whenever the
            // drawer is open and nothing has taken focus, which covers a swipe
            // that settles before the field was ever on screen and any other
            // path that opens the drawer without a drag.
            .onChange(of: state.isOpen) { _, _ in
                renewSearchFocusIfNeeded()
            }
            .onReceive(
                NotificationCenter.default.publisher(
                    for: UIResponder.keyboardWillChangeFrameNotification
                )
            ) { note in
                applyKeyboardFrame(from: note)
            }
            .onReceive(
                NotificationCenter.default.publisher(
                    for: UIResponder.keyboardWillHideNotification
                )
            ) { _ in
                keyboardHeight = 0
            }
    }

    /// The reported frame is in screen coordinates and can sit fully offscreen
    /// while the keyboard is dismissing, so only its on-screen overlap counts.
    private func applyKeyboardFrame(from note: Notification) {
        guard let frame = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect,
              let screen = UIApplication.shared.connectedScenes
                  .compactMap({ ($0 as? UIWindowScene)?.screen })
                  .first
        else { return }
        keyboardHeight = max(0, screen.bounds.maxY - frame.minY)
    }

    private var progress: CGFloat {
        FeatureCommandDrawerGeometry.progress(reveal: state.reveal, openHeight: openHeight)
    }

    private var drawerLayer: some View {
        GeometryReader { proxy in
            // Deliberately laid out inside the page rather than under
            // `ignoresSafeArea`: there the proxy reports a zero top inset and the
            // drawer's own content ends up beneath the status bar. Here the
            // proxy reports the real inset and the page's height, and the drawer
            // still reaches the window's top edge because overlays do not clip.
            let topInset = proxy.safeAreaInsets.top
            let measured = FeatureCommandDrawerGeometry.openHeight(
                availableHeight: proxy.size.height,
                keyboardHeight: keyboardHeight,
                bottomInset: proxy.safeAreaInsets.bottom
            )

            drawer(openHeight: measured, topInset: topInset)
                .offset(
                    y: FeatureCommandDrawerGeometry.drawerOffset(
                        reveal: state.reveal,
                        openHeight: measured,
                        topInset: topInset
                    )
                )
                .opacity(state.isVisible ? 1 : 0)
                .accessibilityHidden(!state.isOpen)
                .onChange(of: measured, initial: true) { _, height in
                    openHeight = height
                    state.synchronize(openHeight: height)
                }
        }
        // The drawer sizes itself against the keyboard explicitly, so it must
        // measure the page at its full height. Letting SwiftUI's keyboard
        // avoidance shrink this layer too would subtract the keyboard twice and
        // leave a band of the page showing between drawer and keyboard.
        .ignoresSafeArea(.keyboard)
        .allowsHitTesting(state.isVisible)
    }

    private var settleAnimation: Animation {
        reduceMotion
            ? .easeOut(duration: 0.2)
            : .spring(response: 0.32, dampingFraction: 0.86)
    }

    private func settle(velocity: CGFloat, openHeight: CGFloat) {
        withAnimation(settleAnimation) {
            state.endDrag(velocity: velocity, openHeight: openHeight)
        } completion: {
            // The last chance to focus, once the drawer has physically arrived:
            // a swipe can settle open before the search field was ever on
            // screen, and a request made then is dropped with no further state
            // change to retry from.
            renewSearchFocusIfNeeded()
        }
    }

    private func renewSearchFocusIfNeeded() {
        guard FeatureCommandDrawerFocus.needsFocusRenewal(
            state: state,
            isFocused: isQueryFocused
        ) else { return }
        isQueryFocused = true
    }

    private func close() {
        withAnimation(settleAnimation) {
            state.close()
        }
    }

    private func scrim(progress: CGFloat) -> some View {
        Color.black
            .opacity(0.34 * progress)
            .ignoresSafeArea()
            .contentShape(Rectangle())
            .onTapGesture { close() }
            .allowsHitTesting(state.isOpen)
            .accessibilityElement()
            .accessibilityAddTraits(.isButton)
            .accessibilityLabel("Close commands")
            .accessibilityIdentifier("command-drawer-scrim")
            // Must stay last: a later accessibility modifier re-exposes the
            // element, leaving a phantom Close button while the drawer is shut.
            .accessibilityHidden(!state.isOpen)
    }

    private func drawer(openHeight: CGFloat, topInset: CGFloat) -> some View {
        VStack(spacing: 0) {
            searchField
                .padding(.horizontal, 12)
                .padding(.top, 6)
            resultList
            handle
        }
        // The layer spans the window, so the drawer reaches from the window's
        // top edge down to its own edge and its bottom lands on the page top.
        .padding(.top, topInset)
        .frame(height: topInset + openHeight, alignment: .top)
        .frame(maxWidth: .infinity)
        // Two layers: the palette surface must be fully opaque so no page
        // content shows through the area the drawer is meant to cover.
        .background(T3Colors.sheet)
        .background(T3Colors.background)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(T3Colors.border)
                .frame(height: 1)
        }
        .shadow(color: T3Colors.shadow, radius: 18, y: 8)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("command-drawer")
    }

    private var searchField: some View {
        HStack(spacing: 9) {
            Image(systemName: "command")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(T3Colors.textTertiary)
            TextField("Search commands, tasks, projects", text: $query)
                .font(.subheadline)
                .foregroundStyle(T3Colors.textPrimary)
                .focused($isQueryFocused)
                .submitLabel(.search)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityIdentifier("command-drawer-search-field")
            if !query.isEmpty {
                Button { query = "" } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(T3Colors.textTertiary)
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear command search")
            }
        }
        .padding(.horizontal, 12)
        .frame(height: T3Metrics.minimumTapTarget)
        .background(T3Colors.input, in: RoundedRectangle(cornerRadius: 12))
        .overlay {
            RoundedRectangle(cornerRadius: 12)
                .stroke(T3Colors.border, lineWidth: 1)
        }
    }

    @ViewBuilder
    private var resultList: some View {
        if items.isEmpty {
            VStack(spacing: 6) {
                Text("No matches")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(T3Colors.textSecondary)
                Text("Try a different search.")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textTertiary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityIdentifier("command-drawer-empty")
        } else {
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(items) { item in
                        row(item)
                    }
                }
                .padding(.vertical, 4)
            }
            // The keyboard is part of the open drawer's layout; dropping it
            // while scrolling results would resize the drawer mid-scroll.
            .scrollDismissesKeyboard(.never)
        }
    }

    private func row(_ item: FeatureCommandDrawerItem) -> some View {
        Button {
            close()
            onSelect(item)
        } label: {
            HStack(spacing: 11) {
                Image(systemName: item.systemImage)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(T3Colors.textTertiary)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 1) {
                    Text(item.title)
                        .font(.subheadline)
                        .foregroundStyle(T3Colors.textPrimary)
                        .lineLimit(1)
                    if let subtitle = item.subtitle {
                        Text(subtitle)
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.textTertiary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .frame(minHeight: T3Metrics.minimumTapTarget, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("command-drawer-item-\(item.id)")
    }

    private var handle: some View {
        Capsule()
            .fill(T3Colors.textTertiary.opacity(0.45))
            .frame(width: 38, height: 5)
            .frame(maxWidth: .infinity)
            .frame(height: 22)
            .contentShape(Rectangle())
            .accessibilityHidden(true)
    }

    /// Closing the drawer takes the keyboard with it, even if something inside
    /// the palette became first responder after the search field.
    private func resignKeyboard() {
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder),
            to: nil,
            from: nil,
            for: nil
        )
    }
}

/// The command gesture uses a native pan recognizer for the same reason the
/// detail surface's back swipe does: a SwiftUI `DragGesture` can begin before
/// it knows the axis of the motion and would compete with Home's recycled
/// collection view and the thread transcript. This recognizer refuses every
/// touch that does not start in the drawer's grab band, so ordinary list
/// scrolling is never a candidate for the palette.
private struct FeatureCommandDrawerGestureView: UIViewRepresentable {
    let reveal: CGFloat
    let isOpen: Bool
    let onBegan: () -> Void
    let onChanged: (CGFloat) -> Void
    let onEnded: (CGFloat) -> Void
    let onCancelled: () -> Void

    func makeUIView(context: Context) -> InstallerView {
        let view = InstallerView()
        apply(to: view)
        return view
    }

    func updateUIView(_ view: InstallerView, context: Context) {
        apply(to: view)
    }

    static func dismantleUIView(_ view: InstallerView, coordinator: ()) {
        view.uninstallGesture()
    }

    private func apply(to view: InstallerView) {
        view.update(
            reveal: reveal,
            isOpen: isOpen,
            onBegan: onBegan,
            onChanged: onChanged,
            onEnded: onEnded,
            onCancelled: onCancelled
        )
    }

    final class InstallerView: UIView {
        private var reveal: CGFloat = 0
        private var isOpen = false
        private var onBegan: (() -> Void)?
        private var onChanged: ((CGFloat) -> Void)?
        private var onEnded: ((CGFloat) -> Void)?
        private var onCancelled: (() -> Void)?
        private weak var gestureHost: UIView?
        private var panGesture: UIPanGestureRecognizer?
        private var gestureDelegate: GestureDelegate?

        override init(frame: CGRect) {
            super.init(frame: frame)
            isUserInteractionEnabled = false
        }

        required init?(coder: NSCoder) {
            fatalError("init(coder:) has not been implemented")
        }

        deinit {
            uninstallGesture()
        }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            if window == nil {
                uninstallGesture()
            } else {
                installGestureIfPossible()
            }
        }

        func update(
            reveal: CGFloat,
            isOpen: Bool,
            onBegan: @escaping () -> Void,
            onChanged: @escaping (CGFloat) -> Void,
            onEnded: @escaping (CGFloat) -> Void,
            onCancelled: @escaping () -> Void
        ) {
            self.reveal = reveal
            self.isOpen = isOpen
            self.onBegan = onBegan
            self.onChanged = onChanged
            self.onEnded = onEnded
            self.onCancelled = onCancelled
            installGestureIfPossible()
        }

        func uninstallGesture() {
            if let panGesture, let gestureHost {
                gestureHost.removeGestureRecognizer(panGesture)
            }
            panGesture = nil
            gestureDelegate = nil
            gestureHost = nil
        }

        // SwiftUI hosts this representable beside, rather than above, the
        // workspace, so install on their shared root view and use this view's
        // own frame to scope which touches the recognizer may receive.
        private func installGestureIfPossible() {
            guard let window, let host = window.rootViewController?.view else { return }
            guard gestureHost !== host else { return }

            uninstallGesture()
            let panGesture = UIPanGestureRecognizer(
                target: self,
                action: #selector(handlePan(_:))
            )
            let gestureDelegate = GestureDelegate(owner: self)
            panGesture.delegate = gestureDelegate
            panGesture.cancelsTouchesInView = false
            panGesture.delaysTouchesBegan = false
            panGesture.maximumNumberOfTouches = 1
            host.addGestureRecognizer(panGesture)
            gestureHost = host
            self.panGesture = panGesture
            self.gestureDelegate = gestureDelegate
        }

        @objc private func handlePan(_ gesture: UIPanGestureRecognizer) {
            switch gesture.state {
            case .began:
                onBegan?()
                onChanged?(gesture.translation(in: gesture.view).y)
            case .changed:
                onChanged?(gesture.translation(in: gesture.view).y)
            case .ended:
                onEnded?(gesture.velocity(in: gesture.view).y)
            case .cancelled, .failed:
                onCancelled?()
            default:
                break
            }
        }

        // Window coordinates keep the grab band unambiguous: the closed drawer's
        // edge is the window's own top safe-area boundary, which is also where
        // the app's top bar starts, so the band needs no SwiftUI measurement.
        fileprivate func canReceive(_ touch: UITouch) -> Bool {
            guard let window,
                  let gestureHost,
                  window === gestureHost.window,
                  window.rootViewController?.presentedViewController == nil else {
                return false
            }
            let location = touch.location(in: nil)
            guard window.bounds.contains(location),
                  FeatureCommandDrawerGesture.canBeginTouch(
                      atY: location.y,
                      reveal: reveal,
                      topInset: window.safeAreaInsets.top
                  ) else {
                return false
            }
            return !InstallerView.isTextEntry(touch.view)
        }

        fileprivate func canBegin(with gesture: UIPanGestureRecognizer) -> Bool {
            FeatureCommandDrawerGesture.shouldBegin(
                velocity: gesture.velocity(in: gesture.view),
                translation: gesture.translation(in: gesture.view),
                isOpen: isOpen
            )
        }

        /// Text entry owns its own drags for caret and selection handles.
        private static func isTextEntry(_ view: UIView?) -> Bool {
            var current = view
            while let candidate = current {
                if candidate is UITextField { return true }
                if let textView = candidate as? UITextView,
                   textView.isEditable || textView.isFirstResponder {
                    return true
                }
                current = candidate.superview
            }
            return false
        }

        private final class GestureDelegate: NSObject, UIGestureRecognizerDelegate {
            weak var owner: InstallerView?

            init(owner: InstallerView) {
                self.owner = owner
            }

            func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
                guard let owner,
                      let panGesture = gestureRecognizer as? UIPanGestureRecognizer else {
                    return false
                }
                return owner.canBegin(with: panGesture)
            }

            func gestureRecognizer(
                _ gestureRecognizer: UIGestureRecognizer,
                shouldReceive touch: UITouch
            ) -> Bool {
                owner?.canReceive(touch) ?? false
            }

            // The command gesture deliberately does not run alongside scroll
            // views. It can only begin in the grab band, and inside that band it
            // owns the drag outright rather than nudging a list at the same time.
            func gestureRecognizer(
                _ gestureRecognizer: UIGestureRecognizer,
                shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
            ) -> Bool {
                otherGestureRecognizer is UIScreenEdgePanGestureRecognizer
            }
        }
    }
}
