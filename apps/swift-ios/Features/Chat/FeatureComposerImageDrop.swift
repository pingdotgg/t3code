import SwiftUI
import UniformTypeIdentifiers

/// How many of an incoming batch of images the composer can take, separated
/// from the SwiftUI plumbing so the cap and the overflow accounting can be
/// tested without a live drag session or pasteboard.
///
/// Paste and drop are two doors into the same room: both produce item
/// providers, both land in the attachment strip, and both must respect the
/// attachment cap while earlier images are still being prepared.
struct FeatureComposerImageIntakePlan: Equatable {
    let acceptedCount: Int
    let firstOrdinal: Int
    let droppedCount: Int

    /// Returns nil when nothing can be accepted, either because the batch is
    /// empty or the cap is already spent by attached and in-flight images.
    static func forProviders(
        providerCount: Int,
        attachmentCount: Int,
        pendingCount: Int,
        maximumCount: Int = FeatureImageAttachmentLimits.maximumCount
    ) -> FeatureComposerImageIntakePlan? {
        guard providerCount > 0 else { return nil }
        let remaining = max(0, maximumCount - attachmentCount - pendingCount)
        let accepted = min(providerCount, remaining)
        guard accepted > 0 else { return nil }

        return FeatureComposerImageIntakePlan(
            acceptedCount: accepted,
            firstOrdinal: attachmentCount + pendingCount + 1,
            droppedCount: providerCount - accepted
        )
    }
}

/// Accepts images dragged onto the composer from another app.
///
/// Registering only `.image` lets the drag session itself reject anything
/// else, so a dropped PDF never lands and there is no failure to explain
/// afterwards.
struct FeatureComposerImageDrop: ViewModifier {
    let isEnabled: Bool
    let shape: RoundedRectangle
    let onDropImages: ([NSItemProvider]) -> Bool

    @State private var isTargeted = false

    func body(content: Content) -> some View {
        content
            .overlay {
                if isTargeted {
                    shape
                        .fill(T3Colors.accent.opacity(0.1))
                        .overlay {
                            shape.strokeBorder(T3Colors.accent, lineWidth: 2)
                        }
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
            .animation(.easeOut(duration: 0.12), value: isTargeted)
            .onDrop(
                of: [.image],
                delegate: FeatureComposerImageDropDelegate(
                    isEnabled: isEnabled,
                    isTargeted: $isTargeted,
                    onDropImages: onDropImages
                )
            )
    }
}

/// Tracks targeting through explicit enter and exit callbacks so the highlight
/// cannot outlive the session, and states the drop operation outright.
private struct FeatureComposerImageDropDelegate: DropDelegate {
    let isEnabled: Bool
    @Binding var isTargeted: Bool
    let onDropImages: ([NSItemProvider]) -> Bool

    func validateDrop(info: DropInfo) -> Bool {
        isEnabled && info.hasItemsConforming(to: [.image])
    }

    func dropEntered(info: DropInfo) {
        isTargeted = true
    }

    // A system-sourced drag (the screenshot thumbnail, Photos) is refused
    // under SwiftUI's default proposal and the session dies mid-air with the
    // highlight still lit. Asking for a copy explicitly is what lets it land.
    func dropUpdated(info: DropInfo) -> DropProposal? {
        DropProposal(operation: .copy)
    }

    func dropExited(info: DropInfo) {
        isTargeted = false
    }

    func performDrop(info: DropInfo) -> Bool {
        isTargeted = false
        return onDropImages(info.itemProviders(for: [.image]))
    }
}
