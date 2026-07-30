import ExpoModulesCore
import UIKit

public final class T3HeaderButtonView: ExpoView {
  private static let size: CGFloat = 44
  private static let symbolSize: CGFloat = 18

  private let button = UIButton(type: .system)
  private var systemImage = "circle"

  let onTriggered = EventDispatcher()

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)

    isAccessibilityElement = false
    button.frame = bounds
    button.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    button.addTarget(self, action: #selector(handlePress), for: .primaryActionTriggered)
    addSubview(button)
    applyConfiguration()
  }

  public override var intrinsicContentSize: CGSize {
    CGSize(width: Self.size, height: Self.size)
  }

  public func setLabel(_ label: String) {
    button.accessibilityLabel = label
  }

  public func setSystemImage(_ systemImage: String) {
    guard self.systemImage != systemImage else {
      return
    }
    self.systemImage = systemImage
    applyConfiguration()
  }

  private func applyConfiguration() {
    var configuration: UIButton.Configuration
    if #available(iOS 26.0, *) {
      configuration = .glass()
      configuration.cornerStyle = .capsule
    } else {
      configuration = .plain()
    }

    configuration.baseForegroundColor = .label
    configuration.contentInsets = .zero
    configuration.image = UIImage(systemName: systemImage)
    configuration.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(
      pointSize: Self.symbolSize,
      weight: .regular
    )
    button.configuration = configuration
  }

  @objc private func handlePress() {
    onTriggered()
  }
}
