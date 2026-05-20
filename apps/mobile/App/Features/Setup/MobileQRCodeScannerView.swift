@preconcurrency import AVFoundation
import SwiftUI

struct MobileQRCodeScannerView: UIViewControllerRepresentable {
    let onScan: (String) -> Void
    let onSetupFailure: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerViewController {
        let controller = ScannerViewController()
        controller.onScan = onScan
        controller.onSetupFailure = onSetupFailure
        return controller
    }

    func updateUIViewController(_ uiViewController: ScannerViewController, context: Context) {
        uiViewController.onScan = onScan
        uiViewController.onSetupFailure = onSetupFailure
    }

    final class ScannerViewController: UIViewController, @preconcurrency AVCaptureMetadataOutputObjectsDelegate {
        var onScan: ((String) -> Void)?
        var onSetupFailure: ((String) -> Void)?
        private let captureSession = AVCaptureSession()
        private let sessionQueue = DispatchQueue(label: "app.t3code.mobile.qr-scanner")
        private var previewLayer: AVCaptureVideoPreviewLayer?
        private var hasScanned = false
        private var isConfigured = false

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .black
            sessionQueue.async { [weak self] in
                self?.configureCaptureSession()
            }
        }

        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            previewLayer?.frame = view.bounds
        }

        override func viewWillAppear(_ animated: Bool) {
            super.viewWillAppear(animated)
            hasScanned = false
            sessionQueue.async { [weak self] in
                guard let self, isConfigured, !captureSession.isRunning else {
                    return
                }
                captureSession.startRunning()
            }
        }

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            sessionQueue.async { [weak self] in
                guard let self, isConfigured, !captureSession.isRunning else {
                    return
                }
                captureSession.startRunning()
            }
        }

        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            sessionQueue.async { [weak self] in
                guard let self, captureSession.isRunning else {
                    return
                }
                captureSession.stopRunning()
            }
        }

        private func configureCaptureSession() {
            let authorizationStatus = AVCaptureDevice.authorizationStatus(for: .video)
            if authorizationStatus == .denied || authorizationStatus == .restricted {
                reportSetupFailure("Camera access is disabled. Allow camera access in Settings or enter the pairing details manually.")
                return
            }

            guard let videoDevice = AVCaptureDevice.default(for: .video) else {
                reportSetupFailure("No camera is available on this device. Enter the pairing details manually.")
                return
            }

            let videoInput: AVCaptureDeviceInput
            do {
                videoInput = try AVCaptureDeviceInput(device: videoDevice)
            } catch {
                reportSetupFailure("The camera could not be started. Enter the pairing details manually.")
                return
            }

            guard captureSession.canAddInput(videoInput) else {
                reportSetupFailure("The camera could not be used for QR scanning. Enter the pairing details manually.")
                return
            }
            captureSession.addInput(videoInput)

            let metadataOutput = AVCaptureMetadataOutput()
            guard captureSession.canAddOutput(metadataOutput) else {
                reportSetupFailure("QR scanning is unavailable on this device. Enter the pairing details manually.")
                return
            }
            captureSession.addOutput(metadataOutput)
            metadataOutput.setMetadataObjectsDelegate(self, queue: sessionQueue)
            metadataOutput.metadataObjectTypes = [.qr]
            isConfigured = true

            DispatchQueue.main.async { [weak self] in
                guard let self else {
                    return
                }
                let previewLayer = AVCaptureVideoPreviewLayer(session: captureSession)
                previewLayer.videoGravity = .resizeAspectFill
                previewLayer.frame = view.bounds
                view.layer.addSublayer(previewLayer)
                self.previewLayer = previewLayer
            }

            if !captureSession.isRunning {
                captureSession.startRunning()
            }
        }

        private func reportSetupFailure(_ message: String) {
            DispatchQueue.main.async { [weak self] in
                self?.onSetupFailure?(message)
            }
        }

        func metadataOutput(
            _ output: AVCaptureMetadataOutput,
            didOutput metadataObjects: [AVMetadataObject],
            from connection: AVCaptureConnection
        ) {
            guard !hasScanned,
                  let readableObject = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
                  let value = readableObject.stringValue
            else {
                return
            }
            hasScanned = true
            captureSession.stopRunning()
            DispatchQueue.main.async { [onScan] in
                onScan?(value)
            }
        }
    }
}
