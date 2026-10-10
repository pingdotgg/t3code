import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
import UIKit

enum FeatureAttachmentPickerSelection {
    case photos([NSItemProvider])
    case image(UIImage)
    case files([URL])
}

/// Owns only the attachment source dialog and its native pickers. UIKit's
/// dismissal completion keeps both source changes and root routes out of the
/// previous controller's dismissal animation.
struct FeatureAttachmentPickerPresenter: UIViewControllerRepresentable {
    var requestID: UUID?
    let maximumCount: Int
    let imagesAllowed: Bool
    let videosAllowed: Bool
    let onPresentationChange: (Bool) -> Void
    let onFinish: (FeatureAttachmentPickerSelection?) -> Void

    func makeUIViewController(context: Context) -> Controller {
        Controller()
    }

    func updateUIViewController(_ controller: Controller, context: Context) {
        controller.configuration = self
        // Reporting a presentation changes SwiftUI state. Leave the current
        // view update first, then use the latest request (which may be cancelled).
        Task { @MainActor [weak controller] in
            controller?.updatePresentation()
        }
    }

    static func dismantleUIViewController(_ controller: Controller, coordinator: ()) {
        controller.cancel()
    }

    class Controller: UIViewController, UIAdaptivePresentationControllerDelegate,
        PHPickerViewControllerDelegate, UIImagePickerControllerDelegate,
        UINavigationControllerDelegate, UIDocumentPickerDelegate {
        private enum Source { case photos, camera, files }

        var configuration: FeatureAttachmentPickerPresenter?
        private var activeRequestID: UUID?
        private var handledRequestID: UUID?
        private var currentController: UIViewController?
        private var nextSource: Source?
        private var selection: FeatureAttachmentPickerSelection?
        private var isTransitioning = false
        private var isClosing = false

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .clear
        }

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            updatePresentation()
        }

        func cancel() {
            configuration?.requestID = nil
            updatePresentation()
        }

        func updatePresentation() {
            guard let configuration else { return }
            if activeRequestID != nil, configuration.requestID != activeRequestID {
                isClosing = true
                nextSource = nil
                selection = nil
            }
            guard !isTransitioning else { return }

            if activeRequestID == nil {
                guard let requestID = configuration.requestID,
                      requestID != handledRequestID,
                      viewIfLoaded?.window != nil else { return }
                activeRequestID = requestID
                handledRequestID = requestID
                configuration.onPresentationChange(true)
                presentSourceDialog()
            } else if isClosing || nextSource != nil {
                if let currentController {
                    isTransitioning = true
                    let didDismiss = {
                        guard self.currentController === currentController else { return }
                        self.currentController = nil
                        self.isTransitioning = false
                        self.updatePresentation()
                    }
                    if currentController.isBeingDismissed,
                       let transition = currentController.transitionCoordinator {
                        transition.animate(alongsideTransition: nil) { _ in didDismiss() }
                    } else {
                        dismissPicker(currentController, completion: didDismiss)
                    }
                } else if isClosing {
                    let result = selection
                    activeRequestID = nil
                    selection = nil
                    isClosing = false
                    configuration.onFinish(result)
                    configuration.onPresentationChange(false)
                } else if let source = nextSource {
                    nextSource = nil
                    presentPicker(source)
                }
            }
        }

        func dismissPicker(_ controller: UIViewController, completion: @escaping () -> Void) {
            // System pickers can present their own child controllers. Dismiss
            // from the owner so UIKit closes the entire picker, not just its child.
            guard let presenter = controller.presentingViewController,
                  presenter.presentedViewController === controller else {
                // An action sheet may already have closed before its action runs.
                completion()
                return
            }
            presenter.dismiss(animated: true, completion: completion)
        }

        private func presentOwned(_ controller: UIViewController) {
            currentController = controller
            controller.overrideUserInterfaceStyle = .dark
            controller.view.tintColor = .white
            controller.presentationController?.delegate = self
            isTransitioning = true
            present(controller, animated: true) {
                self.isTransitioning = false
                self.updatePresentation()
            }
        }

        private func presentSourceDialog() {
            guard let configuration else { return }
            let dialog = UIAlertController(title: "Add attachment", message: nil, preferredStyle: .actionSheet)
            let photos = UIAlertAction(title: "Photo Library", style: .default) { [weak self] _ in
                self?.choose(.photos)
            }
            photos.isEnabled = configuration.imagesAllowed || configuration.videosAllowed
            let camera = UIAlertAction(title: "Camera", style: .default) { [weak self] _ in
                self?.choose(.camera)
            }
            camera.isEnabled = configuration.imagesAllowed && UIImagePickerController.isSourceTypeAvailable(.camera)
            dialog.addAction(photos)
            dialog.addAction(camera)
            dialog.addAction(UIAlertAction(title: "Files", style: .default) { [weak self] _ in
                self?.choose(.files)
            })
            dialog.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self] _ in
                self?.finish(nil)
            })
            dialog.popoverPresentationController?.sourceView = view
            dialog.popoverPresentationController?.sourceRect = view.bounds
            presentOwned(dialog)
        }

        private func choose(_ source: Source) {
            guard activeRequestID != nil, !isClosing else { return }
            nextSource = source
            updatePresentation()
        }

        private func presentPicker(_ source: Source) {
            guard let configuration else { return }
            view.window?.endEditing(true)
            switch source {
            case .photos:
                var options = PHPickerConfiguration()
                options.filter = if configuration.imagesAllowed && configuration.videosAllowed {
                    .any(of: [.images, .videos])
                } else if configuration.videosAllowed {
                    .videos
                } else {
                    .images
                }
                options.selectionLimit = configuration.maximumCount
                options.selection = .ordered
                options.preferredAssetRepresentationMode = .compatible
                let picker = PHPickerViewController(configuration: options)
                picker.delegate = self
                // Keep SwiftUI's route observer in the hierarchy while the
                // system picker covers the screen, so root routes can close it.
                picker.modalPresentationStyle = .overFullScreen
                presentOwned(picker)
            case .camera:
                let picker = UIImagePickerController()
                picker.sourceType = .camera
                picker.cameraCaptureMode = .photo
                picker.delegate = self
                picker.modalPresentationStyle = .overFullScreen
                presentOwned(picker)
            case .files:
                let picker = UIDocumentPickerViewController(
                    forOpeningContentTypes: configuration.videosAllowed ? [.item] : [.image]
                )
                picker.allowsMultipleSelection = true
                picker.delegate = self
                presentOwned(picker)
            }
        }

        private func finish(_ result: FeatureAttachmentPickerSelection?) {
            guard activeRequestID != nil, !isClosing else { return }
            selection = result
            nextSource = nil
            isClosing = true
            updatePresentation()
        }

        func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
            guard presentationController.presentedViewController === currentController else { return }
            currentController = nil
            isTransitioning = false
            if isClosing || nextSource != nil { updatePresentation() }
            else { finish(nil) }
        }

        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            guard picker === currentController else { return }
            finish(.photos(results.map(\.itemProvider)))
        }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            guard picker === currentController else { return }
            finish((info[.originalImage] as? UIImage).map(FeatureAttachmentPickerSelection.image))
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            guard picker === currentController else { return }
            finish(nil)
        }

        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
            guard controller === currentController else { return }
            finish(.files(urls))
        }

        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
            guard controller === currentController else { return }
            finish(nil)
        }
    }
}
