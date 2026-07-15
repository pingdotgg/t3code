#if DEBUG
    import AppKit
    import SwiftUI

    /// `SERGECODE_UI_PROBE_SCENARIO=glass` — measures how much of the desktop
    /// actually survives the window's layer stack at each translucency step.
    ///
    /// The window is non-opaque with a clear background and the behind-window
    /// blur is composited by the WindowServer, so an in-process
    /// `cacheDisplay` capture renders exactly the layers the app draws and
    /// leaves everything else transparent. Alpha in that capture therefore
    /// *is* the app's coverage: `1 - alpha` is what the desktop shows through.
    /// That makes glass verifiable without Screen Recording permission (agents
    /// and CI have none).
    ///
    /// For each step the probe writes the raw capture plus a composite over a
    /// synthetic bright desktop (what the user would see over a light
    /// wallpaper — the worst case for white-on-glass text) and logs per-region
    /// coverage.
    @MainActor
    enum GlassLayeringProbe {
        /// Sampled at each stop so the layering can be compared end to end.
        static let steps: [Double] = [1.0, 0.85, 0.65, 0.5, 0.35]

        static func run(multi: MultiDeviceModel, scenery: SceneryStore, dir: String) async {
            let model = multi.local
            try? FileManager.default.createDirectory(
                atPath: dir, withIntermediateDirectories: true)
            try? await Task.sleep(for: .seconds(2))
            if model.selectedThreadID == nil,
                let threadID = model.threads.first(where: { $0.id == "thread-1" })?.id
                    ?? model.threads.first?.id
            {
                multi.select(threadID: threadID, on: model.deviceID)
            }
            // Let the wallpaper decode and the timeline lay out.
            try? await Task.sleep(for: .seconds(3))

            dumpOpaquePlates()

            let previous = scenery.sceneryTranslucency
            for step in steps {
                scenery.setSceneryTranslucency(step)
                try? await Task.sleep(for: .milliseconds(900))
                capture(step: step, dir: dir)
            }
            scenery.setSceneryTranslucency(previous)
            scenery.flushPendingSettingsSave()
            try? await Task.sleep(for: .milliseconds(200))
            NSApp.terminate(nil)
        }

        // MARK: - Capture

        private static func capture(step: Double, dir: String) {
            guard let window = mainWindow, let view = window.contentView,
                let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds)
            else {
                print("UIProbe: glass t=\(step) no main window")
                return
            }
            view.cacheDisplay(in: view.bounds, to: rep)

            let coverage = Coverage(rep: rep)
            let requested = ScenerySettingsFile.clampTranslucency(step)
            print(
                "UIProbe: glass t=\(fmt(requested)) "
                    + "sidebar=\(coverage.describe(.sidebar)) "
                    + "chat=\(coverage.describe(.chat)) "
                    + "inspector=\(coverage.describe(.inspector)) "
                    + "window=\(coverage.describe(.whole))")

            let tag = Int((requested * 100).rounded())
            write(rep.representation(using: .png, properties: [:]), to: dir, name: "glass-\(tag)-raw")
            write(
                compositeOverSyntheticDesktop(rep), to: dir, name: "glass-\(tag)-over-desktop")
        }

        /// Paints the capture over a bright striped gradient standing in for a
        /// light desktop wallpaper. Anything the app fully covers hides it;
        /// glass lets it through.
        private static func compositeOverSyntheticDesktop(_ rep: NSBitmapImageRep) -> Data? {
            // Core Graphics, not `NSImage.draw`: drawing a cacheDisplay rep
            // through AppKit flattens it against an opaque backing, which
            // would hide the very transparency this probe exists to show.
            let width = rep.pixelsWide
            let height = rep.pixelsHigh
            guard let capture = rep.cgImage,
                let context = CGContext(
                    data: nil, width: width, height: height, bitsPerComponent: 8,
                    bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
            else { return nil }

            let full = CGRect(x: 0, y: 0, width: width, height: height)
            let space = CGColorSpaceCreateDeviceRGB()
            if let gradient = CGGradient(
                colorsSpace: space,
                colors: [
                    CGColor(red: 1.0, green: 0.86, blue: 0.36, alpha: 1),
                    CGColor(red: 0.24, green: 0.76, blue: 1.0, alpha: 1),
                ] as CFArray,
                locations: [0, 1])
            {
                context.drawLinearGradient(
                    gradient, start: .zero,
                    end: CGPoint(x: width, y: height), options: [])
            }
            context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 0.85))
            for x in stride(from: 0, to: width, by: 140) {
                context.fill(CGRect(x: x, y: 0, width: 44, height: height))
            }
            context.draw(capture, in: full)

            guard let composite = context.makeImage() else { return nil }
            return NSBitmapImageRep(cgImage: composite)
                .representation(using: .png, properties: [:])
        }

        private static func write(_ data: Data?, to dir: String, name: String) {
            guard let data else { return }
            let url = URL(fileURLWithPath: dir).appendingPathComponent("\(name).png")
            try? data.write(to: url)
            print("UIProbe: wrote \(url.path)")
        }

        // MARK: - Coverage

        /// Per-region alpha of the app's own drawing. `mean` includes content
        /// (text, cards) so it always reads high; `floor` is the 10th
        /// percentile, i.e. the backdrop between rows — the number that says
        /// whether the desktop is actually visible through the app.
        private struct Coverage {
            enum Region { case sidebar, chat, inspector, whole }

            private let rep: NSBitmapImageRep

            init(rep: NSBitmapImageRep) { self.rep = rep }

            func describe(_ region: Region) -> String {
                let alphas = samples(region)
                guard !alphas.isEmpty else { return "n/a" }
                let mean = alphas.reduce(0, +) / Double(alphas.count)
                let floor = alphas.sorted()[alphas.count / 10]
                return "mean=\(fmt(mean)) floor=\(fmt(floor))"
            }

            private func samples(_ region: Region) -> [Double] {
                let w = rep.pixelsWide
                let h = rep.pixelsHigh
                let rect: (x0: Int, y0: Int, x1: Int, y1: Int)
                switch region {
                case .sidebar:
                    rect = (0, 0, Int(Double(w) * 0.18), h)
                case .chat:
                    // Middle of the wallpaper only: clear of the frosted
                    // header band at the top and the composer glass at the
                    // bottom, both of which paint their own coverage.
                    rect = (
                        Int(Double(w) * 0.22), Int(Double(h) * 0.35),
                        Int(Double(w) * 0.74), Int(Double(h) * 0.78)
                    )
                case .inspector:
                    rect = (Int(Double(w) * 0.80), Int(Double(h) * 0.2), w, h)
                case .whole:
                    rect = (0, 0, w, h)
                }
                var alphas: [Double] = []
                for y in stride(from: rect.y0, to: rect.y1, by: 4) {
                    for x in stride(from: rect.x0, to: rect.x1, by: 4) {
                        guard let color = rep.colorAt(x: x, y: y) else { continue }
                        alphas.append(Double(color.alphaComponent))
                    }
                }
                return alphas
            }
        }

        // MARK: - Diagnostics

        /// Lists the large views that paint an opaque plate (and every
        /// behind-window effect view). A plate over the whole detail or
        /// inspector column means no desktop can reach that column no matter
        /// what the translucency slider says.
        private static func dumpOpaquePlates() {
            guard let root = mainWindow?.contentView else { return }
            let minimumArea: CGFloat = 40_000  // ~200×200pt and up.

            func walk(_ view: NSView, depth: Int) {
                let frame = view.convert(view.bounds, to: root)
                let area = frame.width * frame.height
                if ProcessInfo.processInfo.environment["SERGECODE_GLASS_TREE"] == "1" {
                    print(
                        "UIProbe: glass tree \(String(repeating: "  ", count: depth))"
                            + "\(type(of: view)) frame=\(fmt(frame)) opaque=\(view.isOpaque) "
                            + "layerBG=\(view.layer?.backgroundColor.map { fmt(Double($0.alpha)) } ?? "nil")")
                }
                if let effect = view as? NSVisualEffectView {
                    print(
                        "UIProbe: glass plate \(type(of: effect)) "
                            + "blending=\(effect.blendingMode == .behindWindow ? "behindWindow" : "withinWindow") "
                            + "material=\(effect.material.rawValue) frame=\(fmt(frame))")
                } else if area >= minimumArea,
                    let layer = view.layer,
                    let background = layer.backgroundColor,
                    background.alpha > 0.98
                {
                    print(
                        "UIProbe: glass plate \(type(of: view)) opaqueLayer "
                            + "alpha=\(fmt(Double(background.alpha))) frame=\(fmt(frame))")
                }
                for subview in view.subviews { walk(subview, depth: depth + 1) }
            }
            walk(root, depth: 0)
        }

        private static var mainWindow: NSWindow? {
            NSApp.windows.first {
                $0.isVisible && $0.styleMask.contains(.titled)
                    && $0.styleMask.contains(.resizable)
            }
        }

        nonisolated private static func fmt(_ value: Double) -> String {
            String(format: "%.3f", value)
        }

        private static func fmt(_ rect: CGRect) -> String {
            String(
                format: "(%.0f,%.0f %.0fx%.0f)", rect.origin.x, rect.origin.y, rect.width,
                rect.height)
        }
    }
#endif
