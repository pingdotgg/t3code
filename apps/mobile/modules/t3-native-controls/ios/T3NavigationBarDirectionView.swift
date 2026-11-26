import ExpoModulesCore
import UIKit

final class T3NavigationBarDirectionView: ExpoView {
  var rightToLeft: Bool? {
    didSet { applyDirection() }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    applyDirection()
  }

  // UIKit can reset navigation bar traits across push/pop transitions.
  override func layoutSubviews() {
    super.layoutSubviews()
    applyDirection()
  }

  private func applyDirection() {
    guard window != nil, let rightToLeft else { return }
    var responder = next
    while let current = responder, !(current is UIViewController) {
      responder = current.next
    }
    guard let owner = responder as? UIViewController else { return }

    // Stack.Host's direction prop is Android-only, and Split.Host has no direction prop.
    // UIKit lays out the native navigation bar and split view columns separately.
    let semantic: UISemanticContentAttribute = rightToLeft ? .forceRightToLeft : .forceLeftToRight
    let layout: UITraitEnvironmentLayoutDirection = rightToLeft ? .rightToLeft : .leftToRight
    if let navigation = owner.navigationController {
      let bar = navigation.navigationBar
      if navigation.view.semanticContentAttribute != semantic {
        navigation.view.semanticContentAttribute = semantic
      }
      if bar.semanticContentAttribute != semantic {
        bar.semanticContentAttribute = semantic
      }
      if bar.traitCollection.layoutDirection != layout {
        bar.traitOverrides.layoutDirection = layout
        bar.setNeedsLayout()
      }
    }
    if let split = owner.splitViewController {
      if split.view.semanticContentAttribute != semantic {
        split.view.semanticContentAttribute = semantic
      }
      if split.traitCollection.layoutDirection != layout {
        split.traitOverrides.layoutDirection = layout
        split.view.setNeedsLayout()
      }
    }
  }
}
