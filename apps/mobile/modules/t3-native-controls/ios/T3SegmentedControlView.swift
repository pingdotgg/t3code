import ExpoModulesCore
import UIKit

final class T3SegmentedControlView: ExpoView {
  let onSelectionChange = EventDispatcher()
  private let control = UISegmentedControl()
  var labels: [String] = [] {
    didSet {
      guard labels != oldValue else { return }
      control.removeAllSegments()
      for (index, label) in labels.enumerated() {
        control.insertSegment(withTitle: label, at: index, animated: false)
      }
      updateSelection()
    }
  }
  var selectedIndex = -1 { didSet { updateSelection() } }
  var trackColor: UIColor = .secondarySystemBackground { didSet { control.backgroundColor = trackColor } }
  var selectedColor: UIColor = .secondarySystemFill { didSet { control.selectedSegmentTintColor = selectedColor } }
  var textColor: UIColor = .label { didSet { updateColors() } }
  var mutedColor: UIColor = .secondaryLabel { didSet { updateColors() } }
  var appearance = "light" {
    didSet { overrideUserInterfaceStyle = appearance == "dark" ? .dark : .light }
  }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    addSubview(control)
    control.addTarget(self, action: #selector(selectionChanged), for: .valueChanged)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    control.frame = bounds
  }

  private func updateSelection() {
    control.selectedSegmentIndex = labels.indices.contains(selectedIndex) ? selectedIndex : UISegmentedControl.noSegment
  }

  private func updateColors() {
    control.setTitleTextAttributes([.foregroundColor: mutedColor], for: .normal)
    control.setTitleTextAttributes([.foregroundColor: textColor], for: .selected)
  }

  @objc private func selectionChanged() {
    onSelectionChange(["index": control.selectedSegmentIndex])
  }
}
