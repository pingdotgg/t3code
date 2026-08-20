import SwiftUI

/// What shipped in this build, followed by the builds before it.
///
/// The layout follows the shape people expect from a release-notes screen: a
/// hero title, one grouped card per build, and a row per entry carrying an
/// accent icon tile, a title, and a one-line summary. Entries that recorded
/// long-form copy open it; the rest stay inert.
struct WhatsNewView: View {
    let presentation: WhatsNewPresentation
    let runningBuildLabel: String?
    let appName: String

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                hero

                if let current = presentation.current {
                    buildSection(
                        eyebrow: "In this build",
                        label: current.label ?? runningBuildLabel,
                        build: current
                    )
                }

                if !presentation.earlier.isEmpty {
                    VStack(alignment: .leading, spacing: 20) {
                        Text("Earlier builds")
                            .font(T3Typography.threadHeading3)
                            .foregroundStyle(T3Colors.textPrimary)

                        ForEach(Array(presentation.earlier.enumerated()), id: \.offset) { _, build in
                            buildSection(eyebrow: nil, label: build.label, build: build)
                        }
                    }
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 8)
            .padding(.bottom, 32)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(T3Colors.background)
        .navigationTitle("What's New")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var hero: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("What's New")
                .font(T3Typography.threadHeading1)
                .foregroundStyle(T3Colors.textPrimary)
            Text(heroSubtitle)
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textSecondary)
        }
        .accessibilityElement(children: .combine)
    }

    private var heroSubtitle: String {
        guard let label = presentation.current?.label ?? runningBuildLabel else {
            return "Everything recorded for \(appName)."
        }
        return "\(appName) \(label)"
    }

    @ViewBuilder
    private func buildSection(
        eyebrow: String?,
        label: String?,
        build: WhatsNewChangelog.Build
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if eyebrow != nil || label != nil {
                HStack(spacing: 8) {
                    if let eyebrow {
                        Text(eyebrow.uppercased())
                            .font(T3Typography.eyebrow)
                            .foregroundStyle(T3Colors.accent)
                    }
                    if let label {
                        Text(label)
                            .font(T3Typography.supportingStrong)
                            .foregroundStyle(T3Colors.textSecondary)
                    }
                }
                .accessibilityElement(children: .combine)
            }

            VStack(spacing: 0) {
                ForEach(Array(build.entries.enumerated()), id: \.offset) { index, entry in
                    if index > 0 {
                        Divider()
                            .overlay(T3Colors.separator)
                            .padding(.leading, 66)
                    }
                    entryRow(entry, buildLabel: label)
                }
            }
            .background(T3Colors.surface, in: RoundedRectangle(cornerRadius: 18))
        }
    }

    @ViewBuilder
    private func entryRow(_ entry: WhatsNewChangelog.Entry, buildLabel: String?) -> some View {
        if entry.hasDetail {
            NavigationLink {
                WhatsNewDetailView(entry: entry, buildLabel: buildLabel)
            } label: {
                entryLabel(entry, showsChevron: true)
            }
            .buttonStyle(.plain)
        } else {
            entryLabel(entry, showsChevron: false)
        }
    }

    private func entryLabel(
        _ entry: WhatsNewChangelog.Entry,
        showsChevron: Bool
    ) -> some View {
        HStack(alignment: .top, spacing: 14) {
            WhatsNewSymbolTile(systemName: entry.symbolName, size: 38)

            VStack(alignment: .leading, spacing: 3) {
                Text(entry.title)
                    .font(T3Typography.threadHeading4)
                    .foregroundStyle(T3Colors.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                if let summary = entry.summary {
                    Text(summary)
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            Spacer(minLength: 8)

            if showsChevron {
                Image(systemName: "chevron.right")
                    .font(T3Typography.supportingStrong)
                    .foregroundStyle(T3Colors.textTertiary)
                    .padding(.top, 2)
                    .accessibilityHidden(true)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// The long-form copy a publisher recorded for one entry, plus any screenshots
/// that build shipped for it.
struct WhatsNewDetailView: View {
    let entry: WhatsNewChangelog.Entry
    let buildLabel: String?

    private struct LoadedImage: Identifiable {
        let id: Int
        let image: UIImage
        let caption: String?

        var aspectRatio: CGFloat {
            guard image.size.width > 0, image.size.height > 0 else { return 1 }
            return image.size.width / image.size.height
        }
    }

    @SwiftUI.Environment(\.colorScheme) private var colorScheme
    @State private var loadedImages: [LoadedImage] = []

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                WhatsNewSymbolTile(systemName: entry.symbolName, size: 56)

                VStack(alignment: .leading, spacing: 6) {
                    if let buildLabel {
                        Text(buildLabel.uppercased())
                            .font(T3Typography.eyebrow)
                            .foregroundStyle(T3Colors.accent)
                    }
                    Text(entry.title)
                        .font(T3Typography.threadHeading1)
                        .foregroundStyle(T3Colors.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                    if let summary = entry.summary {
                        Text(summary)
                            .font(T3Typography.threadBody)
                            .foregroundStyle(T3Colors.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .accessibilityElement(children: .combine)

                if entry.detail != nil || !loadedImages.isEmpty {
                    Divider()
                        .overlay(T3Colors.separator)
                }

                if let detail = entry.detail {
                    Text(detail)
                        .font(T3Typography.threadBody)
                        .foregroundStyle(T3Colors.textPrimary)
                        .lineSpacing(3)
                        .fixedSize(horizontal: false, vertical: true)
                }

                ForEach(loadedImages) { loaded in
                    VStack(alignment: .leading, spacing: 8) {
                        Image(uiImage: loaded.image)
                            .resizable()
                            // Height follows the image's own ratio, so the
                            // rounded border always hugs the screenshot no
                            // matter what the scroll view proposes.
                            .aspectRatio(loaded.aspectRatio, contentMode: .fit)
                            .frame(maxWidth: .infinity)
                            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                            .overlay {
                                RoundedRectangle(cornerRadius: 16, style: .continuous)
                                    .strokeBorder(T3Colors.border)
                            }
                            .accessibilityLabel(loaded.caption ?? "Screenshot of \(entry.title)")

                        if let caption = loaded.caption {
                            Text(caption)
                                .font(T3Typography.supporting)
                                .foregroundStyle(T3Colors.textSecondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .padding(.top, 2)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 8)
            .padding(.bottom, 32)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(T3Colors.background)
        .navigationTitle(entry.title)
        .navigationBarTitleDisplayMode(.inline)
        // Keyed on the appearance so switching between light and dark reloads
        // the screenshots that match it.
        .task(id: colorScheme) { loadImages() }
    }

    /// Screenshots that cannot be resolved are simply skipped — a missing or
    /// malformed file leaves the page exactly as it would have been without it.
    private func loadImages() {
        guard let images = entry.images else {
            loadedImages = []
            return
        }
        let isDark = colorScheme == .dark
        loadedImages = images.enumerated().compactMap { index, image in
            guard let loaded = WhatsNewImageStore.image(for: image, isDark: isDark)
            else { return nil }
            return LoadedImage(id: index, image: loaded, caption: image.caption)
        }
    }
}

private struct WhatsNewSymbolTile: View {
    let systemName: String
    let size: CGFloat

    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
            .fill(T3Colors.accent.opacity(0.14))
            .frame(width: size, height: size)
            .overlay {
                Image(systemName: systemName)
                    .font(.system(size: size * 0.45, weight: .semibold))
                    .foregroundStyle(T3Colors.accent)
            }
            .accessibilityHidden(true)
    }
}
