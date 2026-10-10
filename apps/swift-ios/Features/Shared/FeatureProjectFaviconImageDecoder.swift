import Foundation
import UIKit
import WebKit

enum FeatureProjectFaviconImageDecoder {
    @MainActor
    static func renderableData(from data: Data) async -> Data? {
        if UIImage(data: data) != nil {
            return data
        }
        guard isSVG(data) else { return nil }
        return await FeatureProjectSVGRenderSession().render(data)?.pngData()
    }

    private static func isSVG(_ data: Data) -> Bool {
        guard let prefix = String(data: data.prefix(4_096), encoding: .utf8) else {
            return false
        }
        return prefix.range(of: "<svg", options: [.caseInsensitive]) != nil
    }
}

@MainActor
private final class FeatureProjectSVGRenderSession: NSObject, WKNavigationDelegate {
    private var webView: WKWebView?
    private var continuation: CheckedContinuation<UIImage?, Never>?

    func render(_ data: Data) async -> UIImage? {
        await withCheckedContinuation { continuation in
            self.continuation = continuation
            let configuration = WKWebViewConfiguration()
            configuration.websiteDataStore = .nonPersistent()
            let webView = WKWebView(
                frame: CGRect(x: 0, y: 0, width: 64, height: 64),
                configuration: configuration
            )
            webView.navigationDelegate = self
            webView.isOpaque = false
            webView.backgroundColor = .clear
            webView.scrollView.backgroundColor = .clear
            webView.scrollView.isScrollEnabled = false
            self.webView = webView

            let source = data.base64EncodedString()
            webView.loadHTMLString(
                """
                <!doctype html>
                <meta name="viewport" content="width=device-width,initial-scale=1">
                <style>
                  html,body{margin:0;width:64px;height:64px;background:transparent;overflow:hidden}
                  img{display:block;width:64px;height:64px;object-fit:contain}
                </style>
                <img src="data:image/svg+xml;base64,\(source)">
                """,
                baseURL: nil
            )
        }
    }

    func webView(_ webView: WKWebView, didFinish _: WKNavigation!) {
        let configuration = WKSnapshotConfiguration()
        configuration.rect = CGRect(x: 0, y: 0, width: 64, height: 64)
        configuration.afterScreenUpdates = true
        webView.takeSnapshot(with: configuration) { [weak self] image, _ in
            Task { @MainActor in self?.finish(image) }
        }
    }

    func webView(
        _: WKWebView,
        didFail _: WKNavigation!,
        withError _: Error
    ) {
        finish(nil)
    }

    func webView(
        _: WKWebView,
        didFailProvisionalNavigation _: WKNavigation!,
        withError _: Error
    ) {
        finish(nil)
    }

    private func finish(_ image: UIImage?) {
        guard let continuation else { return }
        self.continuation = nil
        webView?.navigationDelegate = nil
        webView = nil
        continuation.resume(returning: image)
    }
}
