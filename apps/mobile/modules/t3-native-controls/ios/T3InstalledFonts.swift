import CoreText
import UIKit

@MainActor
enum T3InstalledFonts {
  static func describe(_ font: UIFont, name: String? = nil) -> [String: Any] {
    func variant(_ weight: UIFont.Weight) -> String {
      let descriptor = UIFontDescriptor(fontAttributes: [
        .family: font.familyName,
        .traits: [UIFontDescriptor.TraitKey.weight: weight],
      ])
      let candidate = UIFont(descriptor: descriptor, size: font.pointSize)
      return candidate.familyName == font.familyName ? candidate.fontName : font.fontName
    }
    // CoreText reports medium as 0.20 while UIKit requests 0.23.
    var emphasisFaces: [String: String] = [:]
    for (key, weight) in [("500", UIFont.Weight.medium), ("600", .semibold), ("700", .bold)] {
      let name = variant(weight)
      guard let candidate = UIFont(name: name, size: font.pointSize),
            let traits = candidate.fontDescriptor.object(forKey: .traits) as? [UIFontDescriptor.TraitKey: Any],
            let actual = traits[.weight] as? NSNumber,
            abs(actual.doubleValue - Double(weight.rawValue)) < 0.04 else { continue }
      emphasisFaces[key] = name
    }
    return [
      "name": name ?? font.fontName,
      "label": font.familyName,
      "regular": font.fontName,
      "medium": variant(.medium),
      "bold": variant(.bold),
      "emphasisFaces": emphasisFaces,
    ]
  }

  static func resolve(_ names: [String], completion: @escaping ([[String: Any]]) -> Void) {
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
  private let completion: ([String: Any]?) -> Void
  private var picker: UIFontPickerViewController?
  private var finished = false

  init(completion: @escaping ([String: Any]?) -> Void) {
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

  private func finish(_ result: [String: Any]?) {
    guard !finished else { return }
    finished = true
    picker?.delegate = nil
    picker = nil
    completion(result)
  }
}
