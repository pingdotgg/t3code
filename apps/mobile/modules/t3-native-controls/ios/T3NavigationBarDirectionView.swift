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
    guard let owner = responder as? UIViewController,
          let navigation = owner.navigationController else { return }

    // Stack.Host's direction prop is Android-only. UIKit lays out the native bar separately.
    let semantic: UISemanticContentAttribute = rightToLeft ? .forceRightToLeft : .forceLeftToRight
    let layout: UITraitEnvironmentLayoutDirection = rightToLeft ? .rightToLeft : .leftToRight
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
}
