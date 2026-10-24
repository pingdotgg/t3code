import Foundation
import Testing
@testable import T3Code

struct FeatureFileViewingTests {
    @Test func htmlAndSVGUseBrowserPreviewEvenWhenTheirLanguageIsKnown() {
        #expect(FeatureFilePreviewKind.infer(path: "index.HTML", language: "html") == .browser)
        #expect(FeatureFilePreviewKind.infer(path: "view.htm") == .browser)
        #expect(FeatureFilePreviewKind.infer(path: "art.svg", language: "xml") == .browser)
        #expect(FeatureFilePreviewKind.infer(path: "source.xml", language: "xml") == .source)
    }

    @Test func audioUsesPlaybackWithoutChangingExistingFormats() {
        for path in ["voice.mp3", "music.M4A", "sound.wav", "audio.ogg", "track.flac", "clip.opus"] {
            #expect(FeatureFilePreviewKind.infer(path: path) == .audio)
        }
        #expect(FeatureFilePreviewKind.infer(path: "demo.mp4") == .video)
        #expect(FeatureFilePreviewKind.infer(path: "image.png") == .image)
        #expect(FeatureFilePreviewKind.infer(path: "notes.md") == .markdown)
        #expect(FeatureFilePreviewKind.infer(path: "report.pdf") == .pdf)
        #expect(FeatureFilePreviewKind.infer(path: "report.docx") == .document)
    }

    @Test func lineDestinationChoosesSourceOnlyForTextAndClampsPartialFiles() {
        for kind in [FeatureFilePreviewKind.markdown, .browser] {
            #expect(FeatureFileViewingMode.initial(kind: kind, line: nil) == .preview)
            #expect(FeatureFileViewingMode.initial(kind: kind, line: 42) == .source)
        }
        for kind in [FeatureFilePreviewKind.image, .audio, .video, .pdf, .document] {
            #expect(FeatureFileViewingMode.initial(kind: kind, line: 42) == .preview)
        }
        #expect(FeatureFileViewingMode.initial(kind: .source, line: nil) == .source)
        #expect(FeatureFileViewingMode.sourceLine(42, lineCount: 100) == 42)
        #expect(FeatureFileViewingMode.sourceLine(100, lineCount: 42) == 42)
        #expect(FeatureFileViewingMode.sourceLine(0, lineCount: 10) == nil)
        #expect(FeatureFileViewingMode.sourceLine(1, lineCount: 0) == nil)
    }

    @MainActor
    @Test func relativeWorkspacePreviewsKeepSiblingAssetAccess() async throws {
        let resolver = FilePreviewResolver()
        for path in ["docs/index.html", "docs/art.svg", "images/image.png", "report.pdf"] {
            let url = try await resolver.previewAssetURL(
                threadID: "environment:thread", path: path, kind: .infer(path: path)
            )
            #expect(url == FilePreviewResolver.workspaceURL)
        }
        #expect(resolver.workspacePaths == ["docs/index.html", "docs/art.svg", "images/image.png", "report.pdf"])
        #expect(resolver.mediaPaths.isEmpty)
        #expect(resolver.threadIDs.allSatisfy { $0 == "environment:thread" })
    }

    @Test func workspacePreviewPolicyKeepsSupportedMediaAndTextAvailable() {
        for path in [
            "docs/index.HTML", "art.svg", "image.png", "report.PDF", "demo.mp4", "clip.webm",
            "voice.aiff", "music.M4A", "audio.oga", "sound.wav", "track.flac", "clip.opus",
            "notes.md", "source.swift", "README", "notes.aif.txt",
        ] {
            #expect(FeatureWorkspacePreviewPolicy.supportsPreview(path: path))
        }
    }

    @MainActor
    @Test func unsupportedWorkspaceFormatsNeverRequestAssetURLs() async {
        let resolver = FilePreviewResolver()
        for fileExtension in [
            "doc", "docx", "key", "numbers", "pages", "ppt", "pptx", "rtf", "xls", "xlsx",
            "aif", "mpeg", "mpg",
        ] {
            for path in [
                "docs/file.\(fileExtension)", "/repo/file.\(fileExtension.uppercased())",
                "/tmp/file.\(fileExtension)", #"C:\Repo\file."# + fileExtension,
            ] {
                #expect(!FeatureWorkspacePreviewPolicy.supportsPreview(path: path))
                // A typed media link must not bypass the path policy with another kind.
                for kind in [FeatureFilePreviewKind.infer(path: path), .browser] {
                    await #expect(throws: FeatureCapabilityUnavailable.self) {
                        try await resolver.previewAssetURL(
                            threadID: "thread", path: path, kind: kind, workspaceRoot: "/repo"
                        )
                    }
                }
            }
        }
        #expect(resolver.workspacePaths.isEmpty)
        #expect(resolver.mediaPaths.isEmpty)
        #expect(resolver.threadIDs.isEmpty)
    }

    @Test func workspaceRestrictionsDoNotChangeAttachmentViewerSelection() {
        for name in ["report.docx", "sheet.xlsx", "slides.pptx", "document.pages", "notes.rtf"] {
            #expect(FeatureFilePreviewKind.infer(path: name) == .document)
            #expect(FeatureAttachmentContentKind.infer(name: name) == .native)
        }
        #expect(FeatureFilePreviewKind.infer(path: "sound.aif") == .audio)
        #expect(FeatureAttachmentContentKind.infer(name: "sound.aif", mimeType: "audio/aiff") == .audio)
        #expect(FeatureAttachmentContentKind.infer(name: "sound.aif") == .native)
        for name in ["movie.mpeg", "movie.mpg"] {
            #expect(FeatureFilePreviewKind.infer(path: name) == .video)
            #expect(FeatureAttachmentContentKind.infer(name: name) == .video)
        }
    }

    @MainActor
    @Test func transcriptWorkspacePagesUseTheirRelativePathIncludingWindowsHosts() async throws {
        let resolver = FilePreviewResolver()
        for (path, root) in [
            ("/repo/docs/./index.html", "/repo"),
            (#"C:\Repo\docs\index.html"#, #"c:\repo"#),
            (#"\\host\share\repo\docs\index.html"#, #"\\host\share\repo"#),
            ("/repo/docs/with#fragment%20name.html", "/repo"),
        ] {
            let url = try await resolver.previewAssetURL(
                threadID: "thread", path: path, kind: .browser, workspaceRoot: root
            )
            #expect(url == FilePreviewResolver.workspaceURL)
        }
        #expect(resolver.workspacePaths == [
            "docs/index.html", "docs/index.html", "docs/index.html", "docs/with#fragment%20name.html",
        ])
        #expect(resolver.mediaPaths.isEmpty)
    }

    @MainActor
    @Test func audioVideoAndOutsideWorkspacePathsKeepExactFileAccess() async throws {
        let resolver = FilePreviewResolver()
        let paths = [
            "audio/voice.mp3", "audio/voice.aiff", "/repo/demo.mp4", "/tmp/voice.wav", "/tmp/art.svg",
            "/repo-other/index.html", "/repo/../other/index.html", "../other/index.html",
        ]
        for path in paths {
            let kind = FeatureFilePreviewKind.infer(path: path)
            #expect(kind.opensLinkedMediaPreview)
            let url = try await resolver.previewAssetURL(
                threadID: "thread", path: path, kind: kind, workspaceRoot: "/repo"
            )
            #expect(url == FilePreviewResolver.mediaURL)
        }
        // A Files route with an absolute path, or a transcript without workspace
        // context, must not infer workspace authority from the path alone.
        let url = try await resolver.previewAssetURL(threadID: "thread", path: "/repo/index.html", kind: .browser)
        #expect(url == FilePreviewResolver.mediaURL)
        #expect(resolver.mediaPaths == paths + ["/repo/index.html"])
        #expect(resolver.workspacePaths.isEmpty)
        #expect(!FeatureFilePreviewKind.markdown.opensLinkedMediaPreview)
        #expect(!FeatureFilePreviewKind.source.opensLinkedMediaPreview)
    }

    @MainActor
    @Test func olderResolversStillPreviewFilesThroughTheirWorkspaceCapability() async throws {
        let resolver = LegacyFilePreviewResolver()
        let url = try await resolver.previewAssetURL(threadID: "thread", path: "demo.mp4", kind: .video)
        #expect(url == FilePreviewResolver.workspaceURL)
        #expect(resolver.paths == ["demo.mp4"])
    }
}

@MainActor
private final class FilePreviewResolver: FeatureWorkspaceAssetResolving {
    static let workspaceURL = URL(string: "https://host.test/workspace/docs/index.html")!
    static let mediaURL = URL(string: "https://host.test/exact/file")!
    var workspacePaths: [String] = []
    var mediaPaths: [String] = []
    var threadIDs: [String] = []

    func workspaceAssetURL(threadID: String, path: String) async throws -> URL {
        threadIDs.append(threadID)
        workspacePaths.append(path)
        return Self.workspaceURL
    }

    func mediaAssetURL(threadID: String, path: String) async throws -> URL {
        threadIDs.append(threadID)
        mediaPaths.append(path)
        return Self.mediaURL
    }
}

@MainActor
private final class LegacyFilePreviewResolver: FeatureWorkspaceAssetResolving {
    var paths: [String] = []

    func workspaceAssetURL(threadID: String, path: String) async throws -> URL {
        paths.append(path)
        return FilePreviewResolver.workspaceURL
    }
}
