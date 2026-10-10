import SwiftUI
import UIKit
import WebKit

struct FeatureEmbeddedContentView: View {
    let item: FeatureV2WorkItem
    let context: FeatureEmbeddedContentContext

    var body: some View {
        if let reference = FeatureEmbeddedContent.reference(raw: item.raw) {
            FeatureEmbeddedContentRow(item: item, reference: reference, context: context)
                .id("\(item.id):\(item.source.detailRevision)")
        }
    }
}

private struct FeatureEmbeddedContentRow: View {
    let context: FeatureEmbeddedContentContext
    @StateObject private var controller: FeatureEmbeddedContentController
    @State private var width: CGFloat = 360

    init(item: FeatureV2WorkItem, reference: FeatureEmbeddedContent, context: FeatureEmbeddedContentContext) {
        self.context = context
        _controller = StateObject(wrappedValue: FeatureEmbeddedContentController(item: item, reference: reference, context: context))
    }

    private var frameHeight: CGFloat {
        switch controller.reference {
        case .html(let reference): CGFloat(reference.frameHeight(width: Double(width)))
        case .mcp: 420
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if controller.closed {
                Button("Show app") { controller.start() }
            } else {
                HStack {
                    Spacer()
                    Button("Expand", systemImage: "arrow.up.left.and.arrow.down.right") {
                        Task { await controller.changeMode(fullscreen: true) }
                    }
                    .disabled(!context.canEnterFullscreen)
                    if case .mcp = controller.reference {
                        Button("Close", systemImage: "xmark") { Task { await controller.close() } }
                    }
                }
                .font(.caption)
                if !controller.fullscreen { content.frame(height: frameHeight) }
            }
        }
        .padding(.vertical, 4)
        .background { GeometryReader { geometry in
            Color.clear.onAppear { width = geometry.size.width }
                .onChange(of: geometry.size.width) { _, value in width = value }
        } }
        .task { controller.context = context; controller.appear() }
        .onChange(of: context.canEnterFullscreen) { _, allowed in
            controller.context = context
            if !allowed, controller.fullscreen { Task { await controller.changeMode(fullscreen: false) } }
        }
        .onDisappear { if !controller.fullscreen { Task { await controller.disappear() } } }
        .fullScreenCover(isPresented: $controller.fullscreen, onDismiss: {
            if !controller.closed { controller.start() }
        }) {
            NavigationStack {
                content.padding(.horizontal, 16).background(.black)
                    .toolbar {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button("Done") { Task { await controller.changeMode(fullscreen: false) } }
                        }
                    }
            }
            .preferredColorScheme(.dark)
            .task { controller.start() }
            .interactiveDismissDisabled()
            .modifier(EmbeddedPrompts(controller: controller))
        }
        .modifier(EmbeddedPrompts(controller: controller, enabled: !controller.fullscreen))
    }

    @ViewBuilder private var content: some View {
        if let failure = controller.failure {
            VStack(alignment: .leading, spacing: 8) {
                Text(failure).font(.caption)
                Button("Reload") { Task { await controller.reload() } }
            }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
        } else if let webView = controller.webView {
            EmbeddedWebView(webView: webView, controller: controller, ownerContext: context)
                .id(controller.documentID)
        } else {
            Text("Loading content…").font(.caption).frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

private struct EmbeddedPrompts: ViewModifier {
    @ObservedObject var controller: FeatureEmbeddedContentController
    var enabled = true

    func body(content: Content) -> some View {
        content
            .sheet(item: Binding(get: { enabled ? controller.confirmation : nil }, set: { value in
                if value == nil { controller.answerConfirmation(false) }
            })) { confirmation in
                NavigationStack {
                    ScrollView { Text(confirmation.detail).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding() }
                        .background(.black).foregroundStyle(.white)
                        .navigationTitle(confirmation.title)
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar {
                            ToolbarItem(placement: .cancellationAction) { Button("Decline") { controller.answerConfirmation(false) } }
                            ToolbarItem(placement: .confirmationAction) { Button("Allow") { controller.answerConfirmation(true) } }
                        }
                }.preferredColorScheme(.dark)
            }
            .sheet(item: Binding(get: { enabled ? controller.sharedFiles : nil }, set: { value in
                if value == nil { controller.clearSharedFiles() }
            })) { files in EmbeddedShareSheet(urls: files.urls) }
    }
}

private struct EmbeddedWebView: UIViewRepresentable {
    let webView: WKWebView
    let controller: FeatureEmbeddedContentController
    let ownerContext: FeatureEmbeddedContentContext
    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {
        controller.context = ownerContext
        controller.updateScroll(uiView)
    }
}

private struct EmbeddedShareSheet: UIViewControllerRepresentable {
    let urls: [URL]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: urls, applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
