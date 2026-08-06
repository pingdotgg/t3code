@preconcurrency import AVFoundation
import SwiftUI
import UIKit

struct QRCodeScannerView: View {
    let onScan: (String) -> Void
    let onCancel: () -> Void
    let onPaste: () -> Void

    @State private var availability: QRScannerAvailability = .checking

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            QRScannerCameraView(
                availability: $availability,
                onScan: onScan
            )
            .ignoresSafeArea()

            LinearGradient(
                colors: [.black.opacity(0.7), .clear, .black.opacity(0.8)],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea()
            .allowsHitTesting(false)

            VStack(spacing: 0) {
                HStack {
                    Button("Cancel", action: onCancel)
                        .font(.body.weight(.semibold))
                    Spacer()
                    Text("Scan QR code")
                        .font(.headline)
                    Spacer()
                    Button("Cancel", action: onCancel)
                        .hidden()
                }
                .padding(.horizontal, 20)
                .frame(height: 56)

                Spacer()

                if availability == .ready {
                    scannerFrame
                    Text("Point your camera at the QR code shown by T3 Code.")
                        .font(T3Typography.threadBody)
                        .foregroundStyle(.white.opacity(0.78))
                        .multilineTextAlignment(.center)
                        .padding(.top, 28)
                } else {
                    unavailableContent
                }

                Spacer()

                Button {
                    onPaste()
                } label: {
                    Label("Paste connection link", systemImage: "doc.on.clipboard")
                        .font(.body.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .frame(minHeight: 50)
                }
                .buttonStyle(.bordered)
                .tint(.white)
                .padding(.horizontal, 28)
                .padding(.bottom, 24)
            }
        }
        .preferredColorScheme(.dark)
    }

    private var scannerFrame: some View {
        RoundedRectangle(cornerRadius: 24)
            .stroke(Color.white.opacity(0.9), lineWidth: 3)
            .frame(width: 252, height: 252)
            .overlay(alignment: .topLeading) {
                Image(systemName: "viewfinder")
                    .resizable()
                    .frame(width: 282, height: 282)
                    .offset(x: -15, y: -15)
                    .foregroundStyle(.white)
            }
            .accessibilityHidden(true)
    }

    @ViewBuilder
    private var unavailableContent: some View {
        switch availability {
        case .checking:
            ProgressView()
                .controlSize(.large)
                .accessibilityLabel("Checking camera")
        case .ready:
            EmptyView()
        case .denied:
            VStack(spacing: 14) {
                Image(systemName: "camera.fill")
                    .font(.system(size: 34))
                Text("Camera access is off")
                    .font(.title3.bold())
                Text("Allow camera access in Settings to scan a pairing code.")
                    .font(T3Typography.threadBody)
                    .foregroundStyle(.white.opacity(0.78))
                    .multilineTextAlignment(.center)
                Button("Open Settings") {
                    guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                    UIApplication.shared.open(url)
                }
                .buttonStyle(.borderedProminent)
                .tint(.white)
                .foregroundStyle(.black)
            }
            .padding(.horizontal, 36)
        case .unavailable:
            VStack(spacing: 14) {
                Image(systemName: "camera.slash.fill")
                    .font(.system(size: 34))
                Text("Camera unavailable")
                    .font(.title3.bold())
                Text("Paste the connection link instead.")
                    .font(T3Typography.threadBody)
                    .foregroundStyle(.white.opacity(0.78))
            }
        }
    }
}

private enum QRScannerAvailability: Equatable {
    case checking
    case ready
    case denied
    case unavailable
}

private struct QRScannerCameraView: UIViewControllerRepresentable {
    @Binding var availability: QRScannerAvailability
    let onScan: (String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(availability: $availability, onScan: onScan)
    }

    func makeUIViewController(context: Context) -> QRScannerViewController {
        let controller = QRScannerViewController()
        context.coordinator.attach(to: controller)
        return controller
    }

    func updateUIViewController(_ controller: QRScannerViewController, context: Context) {}

    static func dismantleUIViewController(
        _ controller: QRScannerViewController,
        coordinator: Coordinator
    ) {
        controller.stop()
    }

    @MainActor
    final class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate {
        private var availability: Binding<QRScannerAvailability>
        private let onScan: (String) -> Void
        private weak var controller: QRScannerViewController?
        private var didScan = false

        init(
            availability: Binding<QRScannerAvailability>,
            onScan: @escaping (String) -> Void
        ) {
            self.availability = availability
            self.onScan = onScan
        }

        func attach(to controller: QRScannerViewController) {
            self.controller = controller
            controller.prepare(delegate: self) { [weak self] nextAvailability in
                self?.availability.wrappedValue = nextAvailability
            }
        }

        nonisolated func metadataOutput(
            _ output: AVCaptureMetadataOutput,
            didOutput metadataObjects: [AVMetadataObject],
            from connection: AVCaptureConnection
        ) {
            guard let value = (metadataObjects.first as? AVMetadataMachineReadableCodeObject)?
                .stringValue
            else {
                return
            }
            Task { @MainActor [weak self] in
                guard let self, !didScan else { return }
                didScan = true
                controller?.stop()
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                onScan(value)
            }
        }
    }
}

@MainActor
private final class QRScannerViewController: UIViewController {
    private let captureSession = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "codes.t3.swift-ios.qr-scanner")
    private var previewLayer: AVCaptureVideoPreviewLayer?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
    }

    // SwiftUI does not reliably dismantle a representable the moment its
    // fullScreenCover dismisses, and backgrounding never dismantles it, so
    // stop the camera on disappear and resume it when the view returns.
    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        stop()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        guard previewLayer != nil else { return }
        let session = captureSession
        sessionQueue.async {
            if !session.isRunning {
                session.startRunning()
            }
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    func prepare(
        delegate: AVCaptureMetadataOutputObjectsDelegate,
        availabilityChanged: @escaping (QRScannerAvailability) -> Void
    ) {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            configure(delegate: delegate, availabilityChanged: availabilityChanged)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                Task { @MainActor in
                    guard let self else { return }
                    if granted {
                        self.configure(
                            delegate: delegate,
                            availabilityChanged: availabilityChanged
                        )
                    } else {
                        availabilityChanged(.denied)
                    }
                }
            }
        case .denied, .restricted:
            availabilityChanged(.denied)
        @unknown default:
            availabilityChanged(.unavailable)
        }
    }

    func stop() {
        let session = captureSession
        sessionQueue.async {
            if session.isRunning {
                session.stopRunning()
            }
        }
    }

    private func configure(
        delegate: AVCaptureMetadataOutputObjectsDelegate,
        availabilityChanged: @escaping (QRScannerAvailability) -> Void
    ) {
        guard let camera = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: camera),
              captureSession.canAddInput(input)
        else {
            availabilityChanged(.unavailable)
            return
        }

        let output = AVCaptureMetadataOutput()
        guard captureSession.canAddOutput(output) else {
            availabilityChanged(.unavailable)
            return
        }

        captureSession.beginConfiguration()
        captureSession.sessionPreset = .high
        captureSession.addInput(input)
        captureSession.addOutput(output)
        output.setMetadataObjectsDelegate(delegate, queue: .main)
        output.metadataObjectTypes = [.qr]
        captureSession.commitConfiguration()

        let preview = AVCaptureVideoPreviewLayer(session: captureSession)
        preview.videoGravity = .resizeAspectFill
        preview.frame = view.bounds
        view.layer.insertSublayer(preview, at: 0)
        previewLayer = preview
        availabilityChanged(.ready)

        let session = captureSession
        sessionQueue.async {
            session.startRunning()
        }
    }
}
