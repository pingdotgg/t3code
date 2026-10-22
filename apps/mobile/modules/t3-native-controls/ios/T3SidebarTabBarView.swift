import ExpoModulesCore
import UIKit

final class T3SidebarTabBarView: ExpoView, UITabBarDelegate {
  let onSelectionChange = EventDispatcher()
  private let tabBar = UITabBar()
  var selectedIndex = 0 { didSet { updateSelection() } }
  var selectedColor: UIColor = .systemBlue { didSet { tabBar.tintColor = selectedColor } }
  var appearance = "light" {
    didSet { overrideUserInterfaceStyle = appearance == "dark" ? .dark : .light }
  }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    let iconBundle = Bundle(for: Self.self).url(forResource: "T3NativeControlIcons", withExtension: "bundle").flatMap(Bundle.init(url:))
    let pullRequestIcon = UIImage(named: "pull-request", in: iconBundle, compatibleWith: nil)?.withRenderingMode(.alwaysTemplate)
    tabBar.items = [
      UITabBarItem(title: "Threads", image: tabIcon(UIImage(systemName: "text.bubble")), tag: 0),
      UITabBarItem(title: "Pulls", image: tabIcon(pullRequestIcon), tag: 1),
    ]
    tabBar.items?.last?.accessibilityLabel = "Pull requests"
    tabBar.items?.first?.selectedImage = tabIcon(UIImage(systemName: "text.bubble.fill"))
    tabBar.itemPositioning = .fill
    tabBar.delegate = self
    addSubview(tabBar)
    updateSelection()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    tabBar.frame = bounds
    updateSelection()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    updateSelection()
  }

  // Give symbols and bitmap assets the same image box; UIKit otherwise scales symbols independently.
  private func tabIcon(_ image: UIImage?) -> UIImage? {
    guard let image else { return nil }
    let canvas = CGSize(width: 28, height: 28)
    let scale = min(24 / image.size.width, 24 / image.size.height)
    let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
    return UIGraphicsImageRenderer(size: canvas).image { _ in
      image.draw(in: CGRect(x: (canvas.width - size.width) / 2, y: (canvas.height - size.height) / 2, width: size.width, height: size.height))
    }.withRenderingMode(.alwaysTemplate)
  }

  private func updateSelection() {
    guard let items = tabBar.items, items.indices.contains(selectedIndex) else { return }
    guard tabBar.selectedItem !== items[selectedIndex] else { return }
    tabBar.selectedItem = items[selectedIndex]
  }

  func tabBar(_ tabBar: UITabBar, didSelect item: UITabBarItem) {
    onSelectionChange(["index": item.tag])
  }
}
