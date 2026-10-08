import ExpoModulesCore
import UIKit

/// One continuous blur with a rounded-rect hole, horizontally centered. A
/// single masked effect view avoids the seams of tiling separate blurs.
final class T3FrostedCutoutView: ExpoView {
  var cutoutTop: CGFloat = 0 { didSet { setNeedsLayout() } }
  var cutoutWidth: CGFloat = 0 { didSet { setNeedsLayout() } }
  var cutoutHeight: CGFloat = 0 { didSet { setNeedsLayout() } }
  var cutoutRadius: CGFloat = 0 { didSet { setNeedsLayout() } }
  /// Follows the app theme, which can differ from the system appearance.
  var appearance: String = "dark" {
    didSet {
      effectView.effect = UIBlurEffect(
        style: appearance == "light" ? .systemThinMaterialLight : .systemThinMaterialDark)
    }
  }

  private let effectView = UIVisualEffectView(effect: UIBlurEffect(style: .systemThinMaterialDark))
  private let cutoutMaskView = UIView()
  private let maskLayer = CAShapeLayer()

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isUserInteractionEnabled = false
    maskLayer.fillRule = .evenOdd
    cutoutMaskView.layer.addSublayer(maskLayer)
    effectView.mask = cutoutMaskView
    addSubview(effectView)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    effectView.frame = bounds
    cutoutMaskView.frame = bounds
    maskLayer.frame = bounds
    let path = UIBezierPath(rect: bounds)
    if cutoutWidth > 0, cutoutHeight > 0 {
      let hole = CGRect(
        x: (bounds.width - cutoutWidth) / 2,
        y: cutoutTop,
        width: cutoutWidth,
        height: cutoutHeight
      )
      path.append(UIBezierPath(roundedRect: hole, cornerRadius: cutoutRadius))
    }
    maskLayer.path = path.cgPath
  }
}
