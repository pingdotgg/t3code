import AVKit
import QuickLook
import SwiftUI
import UniformTypeIdentifiers
import WebKit

struct ThreadAttachments: View {
    let files: [FfiAttachment]
    let store: CoreStore
    var body: some View {
        let images = files.filter { $0.isImage }
        let others = files.filter { !$0.isImage }
        VStack(alignment: .leading, spacing: 3) {
            if !images.isEmpty {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 3), count: min(2, images.count)), spacing: 3) {
                    ForEach(images, id: \.id) { AttachmentTile(file: $0, store: store) }
                }
            }
            ForEach(others, id: \.id) { file in
                let top: CGFloat = images.isEmpty && file.id == others.first?.id ? 11 : 4
                let bottom: CGFloat = file.id == others.last?.id ? 11 : 4
                AttachmentTile(file: file, store: store)
                    .clipShape(UnevenRoundedRectangle(
                        topLeadingRadius: top, bottomLeadingRadius: bottom,
                        bottomTrailingRadius: bottom, topTrailingRadius: top
                    ))
            }
        }
        .clipShape(.rect(cornerRadius: 11))
    }
}

private struct AttachmentTile: View {
    let file: FfiAttachment
    let store: CoreStore
    @Environment(\.connTheme) private var theme
    @State private var signedURL: URL?
    @State private var preview: URL?
    @State private var directory: URL?
    @State private var busy = false
    private enum Failure {
        case preview, download
    }
    @State private var failure: Failure?
    @State private var attempt = 0
    @State private var player: AVPlayer?
    private var video: Bool { file.mimeType.hasPrefix("video/") }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let player {
                VideoPlayer(player: player).aspectRatio(16 / 9, contentMode: .fit)
                    .onDisappear { player.pause() }
            } else if file.isImage, let signedURL {
                Button { Task { await openFile() } } label: {
                    Color.clear.aspectRatio(4 / 3, contentMode: .fit).overlay {
                        AsyncImage(url: signedURL) { phase in
                            if let image = phase.image { image.resizable().scaledToFill() }
                            else { fileLabel }
                        }
                    }.clipped()
                }
            } else {
                Button {
                    if video { attempt += 1 } else { Task { await openFile() } }
                } label: { fileLabel }
            }
            if let failure {
                Button {
                    self.failure = nil
                    switch failure {
                    case .preview: attempt += 1
                    case .download: Task { await openFile() }
                    }
                } label: {
                    Label(failure == .download ? "Attachment unavailable. Retry" : "Preview unavailable. Retry",
                          systemImage: "arrow.clockwise").font(.caption)
                }
            }
        }
        .background(theme.card)
        .buttonStyle(.plain)
        .disabled(busy)
        .accessibilityLabel(file.name)
        .task(id: "\(file.id)|\(attempt)|\(store.status == .connected)") {
            guard (file.isImage || video), store.status == .connected else { return }
            do {
                let url = try await store.assetURL(id: file.id, name: file.name, mime: file.mimeType)
                try Task.checkCancellation()
                signedURL = url
                if video { player = AVPlayer(url: url) }
            } catch {
                if !Task.isCancelled { failure = .preview }
            }
        }
        .quickLookPreview($preview)
        .onChange(of: preview) { old, new in
            if old != nil && new == nil { removeDownload() }
        }
        .onDisappear { if preview == nil { removeDownload() } }
    }

    private var fileIcon: Image {
        switch (file.name as NSString).pathExtension.lowercased() {
        case "doc", "docx", "odt": Image("thread-file-word")
        case "xls", "xlsx", "ods": Image("thread-file-spreadsheet")
        case "pdf": Image("thread-file-pdf")
        case "md", "markdown": Image("thread-file-markdown")
        case "zip": Image("thread-file-zip")
        default: connImage(video ? "play.rectangle" : file.isImage ? "photo" : "doc.text")
        }
    }

    private var fileLabel: some View {
        HStack(spacing: 8) {
            fileIcon.resizable().scaledToFit().frame(width: 14, height: 14)
                .foregroundStyle(theme.mutedForeground)
            Text(file.name).fontWeight(.medium).lineLimit(2).truncationMode(.middle)
            Spacer(minLength: 4)
            if busy { ProgressView().controlSize(.small) }
            else { Text(ByteCountFormatter.string(fromByteCount: file.sizeBytes, countStyle: .file)).foregroundStyle(theme.mutedForeground) }
        }
        .font(.system(size: 13))
        .padding(10).contentShape(Rectangle())
    }

    private func openFile() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let epoch = store.identityEpoch
            let url = try await store.assetURL(id: file.id, name: file.name, mime: file.mimeType)
            let (temp, response) = try await URLSession.shared.download(from: url)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw URLError(.badServerResponse) }
            guard store.identityEpoch == epoch else { return }
            removeDownload()
            let folder = URL.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false)
            directory = folder
            let name = (file.name as NSString).lastPathComponent
            let local = folder.appending(path: ["", ".", "..", "/"].contains(name) ? "Attachment" : name)
            try FileManager.default.moveItem(at: temp, to: local)
            preview = local
            failure = nil
        } catch {
            failure = .download
            removeDownload()
        }
    }

    private func removeDownload() {
        if let directory { try? FileManager.default.removeItem(at: directory) }
        directory = nil
    }
}

struct ThreadEmbed: View {
    let store: CoreStore
    let thread: String
    let item: String
    @State private var session: ThreadMcpApp?
    let attachment: String
    let title: String
    let height: CGFloat
    let mcp: Bool
    @State private var url: URL?
    @State private var failed = false
    @State private var attempt = 0
    @State private var expanded = false

    var body: some View {
        ThreadCard {
            Label {
                Text(mcp ? "MCP app" : "HTML preview")
            } icon: {
                (mcp ? Image("thread-mcp") : connImage("laptopcomputer"))
                    .resizable().scaledToFit().frame(width: 14, height: 14)
            }
            Spacer()
            Button { expanded = true } label: { Image(systemName: "arrow.up.left.and.arrow.down.right").padding(6) }
                .disabled(url == nil || failed).accessibilityLabel("Expand " + title)
        } content: {
            if failed {
                Button("Preview unavailable. Retry") { attempt += 1 }.padding()
            } else if let url {
                Group {
                    if expanded { Color.clear }
                    else { SandboxedPage(url: url, title: title, session: session, fullscreen: false) { failed = true } }
                }.frame(height: min(480, max(80, height)))
            } else { ProgressView().padding() }
        }
        .task(id: "\(attachment)|\(attempt)|\(store.status == .connected)") {
            failed = false
            url = nil
            session = nil
            do {
                let asset = try await store.assetURL(id: attachment, name: "preview.html", mime: "text/html", mcp: mcp)
                let app = mcp ? try await store.mcpApp(thread: thread, item: item, attachment: attachment) : nil
                if !Task.isCancelled { session = app; url = asset }
            } catch { if !Task.isCancelled { failed = true } }
        }
        .sheet(isPresented: $expanded) {
            NavigationStack {
                if let url { SandboxedPage(url: url, title: title, session: session, fullscreen: true) {
                    expanded = false
                    failed = true
                }.navigationTitle(title)
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar { Button("Done") { expanded = false } } }
            }
        }
    }
}
