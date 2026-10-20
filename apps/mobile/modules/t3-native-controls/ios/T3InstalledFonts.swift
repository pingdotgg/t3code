import CoreText
import UIKit

@MainActor
enum T3InstalledFonts {
  static func describe(_ font: UIFont, name: String? = nil) -> [String: String] {
    func variant(_ weight: UIFont.Weight) -> String {
      let descriptor = UIFontDescriptor(fontAttributes: [
        .family: font.familyName,
        .traits: [UIFontDescriptor.TraitKey.weight: weight],
      ])
      let candidate = UIFont(descriptor: descriptor, size: font.pointSize)
      return candidate.familyName == font.familyName ? candidate.fontName : font.fontName
    }
    return [
      "name": name ?? font.fontName,
      "label": font.familyName,
      "regular": font.fontName,
      "medium": variant(.medium),
      "bold": variant(.bold),
    ]
  }

  static func resolve(_ names: [String], completion: @escaping ([[String: String]]) -> Void) {
    guard !names.isEmpty else { completion([]); return }
    // Provider fonts must be requested again for each process. Persist names,
    // not file URLs: iOS owns the files and the picker grants family access.
    let descriptors = names.map { CTFontDescriptorCreateWithAttributes([kCTFontNameAttribute: $0] as CFDictionary) }
    CTFontManagerRequestFonts(descriptors as CFArray) { _ in
      DispatchQueue.main.async {
        completion(names.compactMap { name in
          guard let font = UIFont(name: name, size: 16) else { return nil }
          return describe(font, name: name)
        })
      }
    }
  }
}

@MainActor
final class T3FontPickerPresentation: NSObject, UIFontPickerViewControllerDelegate, UIAdaptivePresentationControllerDelegate {
  private let completion: ([String: String]?) -> Void
  private var picker: UIFontPickerViewController?
  private var finished = false

  init(completion: @escaping ([String: String]?) -> Void) {
    self.completion = completion
  }

  func present(from presenter: UIViewController, selectedName: String?) {
    let configuration = UIFontPickerViewController.Configuration()
    configuration.includeFaces = false
    let picker = UIFontPickerViewController(configuration: configuration)
    if let selectedName, let font = UIFont(name: selectedName, size: 16) {
      picker.selectedFontDescriptor = font.fontDescriptor
    }
    picker.delegate = self
    self.picker = picker
    presenter.present(picker, animated: true)
    picker.presentationController?.delegate = self
  }

  func fontPickerViewControllerDidPickFont(_ viewController: UIFontPickerViewController) {
    guard let descriptor = viewController.selectedFontDescriptor else { dismiss(); return }
    let result = T3InstalledFonts.describe(UIFont(descriptor: descriptor, size: 16))
    viewController.dismiss(animated: true) { self.finish(result) }
  }

  func fontPickerViewControllerDidCancel(_ viewController: UIFontPickerViewController) {
    dismiss()
  }

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    finish(nil)
  }

  func dismiss() {
    guard let picker else { finish(nil); return }
    picker.dismiss(animated: true) { self.finish(nil) }
  }

  private func finish(_ result: [String: String]?) {
    guard !finished else { return }
    finished = true
    picker?.delegate = nil
    picker = nil
    completion(result)
  }
}
