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
    @Binding var restoresPriorResponderOnClose: Bool
    let items: [FeatureCommandDrawerItem]
    let onSelect: (FeatureCommandDrawerItem) -> Void
    @ViewBuilder let content: Content

    @FocusState private var isQueryFocused: Bool
    @State private var responderOwnership = FeatureCommandDrawerResponderOwnership()
    @State private var hasRenewedSearchFocusAfterSettle = false

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
        presentedContent
            .overlay {
                scrim(progress: progress)
            }
            .overlay(alignment: .top) {
                drawerLayer
            }
            .background {
                FeatureCommandDrawerGestureView(
                    reveal: FeatureCommandDrawerPresentationGeometry.reveal(
                        state: state,
                        measuredOpenHeight: openHeight
                    ),
                    isOpen: state.isOpen,
                    onBegan: { responder in
                        responderOwnership.begin(from: responder)
                        state.synchronize(openHeight: openHeight)
                        state.beginDrag()
                    },
                    onChanged: { translation in
                        state.updateDrag(translation: translation, openHeight: openHeight)
                    },
                    onEnded: { velocity in
                        settle(velocity: velocity, openHeight: openHeight)
                    },
                    onCancelled: {
                        withAnimation(settleAnimation) {
                            state.cancelDrag(openHeight: openHeight)
                        }
                        responderOwnership.cancel(returningToOpen: state.isOpen)
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
                    hasRenewedSearchFocusAfterSettle = false
                    responderOwnership.close(
                        restoringPrior: restoresPriorResponderOnClose
                    )
                    restoresPriorResponderOnClose = true
                }
            }
            // …but the request above is made while the field is still above the
            // window's top edge, where it can be dropped. Renew it whenever the
            // drawer is open and nothing has taken focus, which covers a swipe
            // that settles before the field was ever on screen and any other
            // path that opens the drawer without a drag.
            .onChange(of: state.isOpen) { _, isOpen in
                if !isOpen {
                    hasRenewedSearchFocusAfterSettle = false
                }
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

    @ViewBuilder
    private var presentedContent: some View {
        if FeatureCommandDrawerAccessibility.workspaceIsHidden(state) {
            // NavigationSplitView hosts UIKit accessibility descendants that a
            // dynamic hidden modifier alone can leave exposed. Collapse those
            // descendants into this boundary before hiding it.
            content
                .accessibilityElement(children: .ignore)
                .accessibilityHidden(true)
        } else {
            content
        }
    }

    /// The reported frame is in screen coordinates. Measure it against this
    /// app's key window so another scene, or an undocked keyboard, cannot
    /// shorten the drawer.
    private func applyKeyboardFrame(from note: Notification) {
        guard let frame = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect,
              let window = UIApplication.shared.connectedScenes
                  .compactMap({ $0 as? UIWindowScene })
                  .filter({ $0.activationState == .foregroundActive })
                  .flatMap(\.windows)
                  .first(where: \.isKeyWindow)
        else { return }
        let windowFrame = window.screen.coordinateSpace.convert(window.bounds, from: window)
        keyboardHeight = FeatureCommandDrawerGeometry.keyboardOverlap(
            keyboardFrame: frame,
            windowFrame: windowFrame
        )
    }

    private var progress: CGFloat {
        FeatureCommandDrawerGeometry.progress(
            reveal: FeatureCommandDrawerPresentationGeometry.reveal(
                state: state,
                measuredOpenHeight: openHeight
            ),
            openHeight: openHeight
        )
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
                        reveal: FeatureCommandDrawerPresentationGeometry.reveal(
                            state: state,
                            measuredOpenHeight: measured
                        ),
                        openHeight: measured,
                        topInset: topInset
                    )
                )
                .opacity(state.isVisible ? 1 : 0)
                .accessibilityHidden(FeatureCommandDrawerAccessibility.drawerIsHidden(state))
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
            let opens = state.endDrag(velocity: velocity, openHeight: openHeight)
            responderOwnership.settle(open: opens)
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
            isFocused: isQueryFocused,
            hasRenewedAfterSettle: hasRenewedSearchFocusAfterSettle
        ) else { return }
        hasRenewedSearchFocusAfterSettle = true
        isQueryFocused = true
    }

    private func close(restoringPrior: Bool = true) {
        responderOwnership.close(restoringPrior: restoringPrior)
        restoresPriorResponderOnClose = true
        withAnimation(settleAnimation) {
            state.close()
        }
    }

    @ViewBuilder
    private func scrim(progress: CGFloat) -> some View {
        if FeatureCommandDrawerAccessibility.scrimIsHidden(state) {
            scrimSurface(progress: progress)
                .accessibilityHidden(true)
        } else {
            scrimSurface(progress: progress)
                .accessibilityElement()
                .accessibilityAddTraits(.isButton)
                .accessibilityLabel(FeatureCommandDrawerAccessibility.scrimLabel)
                .accessibilityIdentifier(FeatureCommandDrawerAccessibility.scrimIdentifier)
        }
    }

    private func scrimSurface(progress: CGFloat) -> some View {
        Color.black
            .opacity(0.34 * progress)
            .ignoresSafeArea()
            .contentShape(Rectangle())
            .onTapGesture { close() }
            .allowsHitTesting(state.isOpen)
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
        .accessibilityAddTraits(.isModal)
        .accessibilityIdentifier(FeatureCommandDrawerAccessibility.drawerIdentifier)
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
                .accessibilityLabel(FeatureCommandDrawerAccessibility.searchLabel)
                .accessibilityIdentifier(FeatureCommandDrawerAccessibility.searchIdentifier)
            if !query.isEmpty {
                Button { query = "" } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(T3Colors.textTertiary)
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(FeatureCommandDrawerAccessibility.clearSearchLabel)
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
            .accessibilityIdentifier(FeatureCommandDrawerAccessibility.emptyIdentifier)
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
            close(restoringPrior: false)
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
        .accessibilityLabel(item.title)
        .accessibilityValue(item.subtitle ?? "")
        .accessibilityIdentifier(FeatureCommandDrawerAccessibility.itemIdentifier(item))
    }

    private var handle: some View {
        Capsule()
            .fill(T3Colors.textTertiary.opacity(0.45))
            .frame(width: 38, height: 5)
            .frame(maxWidth: .infinity)
            .frame(height: FeatureCommandDrawerGesture.handleGrabHeight)
            .contentShape(Rectangle())
            .accessibilityHidden(true)
    }
}
