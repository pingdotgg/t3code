import ExpoModulesCore
import UIKit

private final class WorkspaceTabBar: UITabBar {
  var onContentLayout: ((CGRect) -> Void)?

  override func layoutSubviews() {
    super.layoutSubviews()
    // iOS 26.6 doesn't copy item identifiers onto its tab buttons; the bar holds no other controls.
    let identified = tabButtons(in: self) { $0.accessibilityIdentifier?.hasPrefix("workspace-tab-") == true }
    let buttons = identified.isEmpty ? tabButtons(in: self) { _ in true } : identified
    let row = buttons.reduce(CGRect.null) { $0.union(convert($1.bounds, from: $1)) }
    if !row.isNull { onContentLayout?(row) }
  }

  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    invalidateIntrinsicContentSize()
  }

  private func tabButtons(in view: UIView, matching match: (UIView) -> Bool) -> [UIView] {
    view.subviews.filter { !$0.isHidden }.flatMap { subview in
      if subview is UIControl, match(subview) { return [subview] }
      return tabButtons(in: subview, matching: match)
    }
  }
}

final class T3SidebarTabBarView: ExpoView, UITabBarDelegate {
  let onSelectionChange = EventDispatcher()
  let onCompose = EventDispatcher()
  private let tabBar = WorkspaceTabBar()
  private let composeButton = UIButton(type: .system)
  private lazy var tabBarTrailing = tabBar.trailingAnchor.constraint(equalTo: trailingAnchor)
  private var itemsByTab: [String: UITabBarItem] = [:]
  var tabs = ["threads", "pullRequests", "usage", "settings"] {
    didSet { if tabs != oldValue { updateItems() } }
  }
  var selectedTab = "threads" { didSet { updateSelection() } }
  var selectedColor: UIColor = .systemBlue { didSet { tabBar.tintColor = selectedColor } }
  var compact = false {
    didSet {
      tabBarTrailing.constant = showsCompose ? (compact ? -64 : -76) : 0
      tabBar.setNeedsLayout()
    }
  }
  var showsCompose = false {
    didSet {
      composeButton.isHidden = !showsCompose
      tabBarTrailing.constant = showsCompose ? (compact ? -64 : -76) : 0
      setNeedsLayout()
    }
  }
  var appearance = "light" {
    didSet { overrideUserInterfaceStyle = appearance == "dark" ? .dark : .light }
  }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    tabBar.itemPositioning = .fill
    // iPad's regular bar uses a compressed inline row even with fill positioning.
    // This floating sidebar control needs the same full-size items as a phone bar.
    if #available(iOS 17.0, *) {
      tabBar.traitOverrides.horizontalSizeClass = .compact
    }
    tabBar.delegate = self
    tabBar.translatesAutoresizingMaskIntoConstraints = false
    addSubview(tabBar)
    NSLayoutConstraint.activate([
      tabBar.leadingAnchor.constraint(equalTo: leadingAnchor),
      tabBarTrailing,
      tabBar.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])
    // UIKit's floating row changes with window geometry. Follow its laid-out items
    // instead of estimating their position from a second set of safe-area updates.
    tabBar.onContentLayout = { [weak self] frame in self?.layoutCompose(alongside: frame) }
    composeButton.accessibilityLabel = "New chat"
    composeButton.addAction(UIAction { [weak self] _ in self?.onCompose() }, for: .touchUpInside)
    composeButton.isHidden = true
    addSubview(composeButton)
    configureCompose()
    prepareItems()
    updateItems()
  }

  private func configureCompose() {
    var configuration: UIButton.Configuration
    if #available(iOS 26.0, *) {
      configuration = .glass()
    } else {
      configuration = .gray()
    }
    configuration.cornerStyle = .capsule
    configuration.baseForegroundColor = .label
    configuration.image = UIImage(systemName: "square.and.pencil")
    configuration.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(pointSize: 24)
    composeButton.configuration = configuration
  }

  private func prepareItems() {
    let iconBundle = Bundle(for: Self.self).url(forResource: "T3NativeControlIcons", withExtension: "bundle").flatMap(Bundle.init(url:))
    let pullRequestIcon = UIImage(named: "pull-request", in: iconBundle, compatibleWith: nil)?.withRenderingMode(.alwaysTemplate)
    let labels = ["threads": "Chats", "pullRequests": "PRs", "usage": "Usage", "settings": "Settings"]
    let symbols = ["threads": "text.bubble", "usage": "chart.bar.xaxis", "settings": "gearshape"]
    for (tab, label) in labels {
      let icon = tab == "pullRequests" ? pullRequestIcon : UIImage(systemName: symbols[tab] ?? "circle")
      let item = UITabBarItem(title: nil, image: tabIcon(icon), tag: 0)
      item.accessibilityLabel = label
      item.accessibilityIdentifier = "workspace-tab-\(tab)"
      if tab == "threads" { item.selectedImage = tabIcon(UIImage(systemName: "text.bubble.fill")) }
      itemsByTab[tab] = item
    }
  }

  private func updateItems() {
    tabBar.items = tabs.enumerated().compactMap { index, tab in
      guard let item = itemsByTab[tab] else { return nil }
      item.tag = index
      return item
    }
    updateSelection()
  }

  private func layoutCompose(alongside frame: CGRect) {
    guard showsCompose, frame.height > 0 else { return }
    let row = convert(frame, from: tabBar)
    let size = row.height + 8
    composeButton.frame = CGRect(x: row.maxX + 16, y: row.midY - size / 2, width: size, height: size)
  }

  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    if showsCompose, let target = composeButton.hitTest(convert(point, to: composeButton), with: event) {
      return target
    }
    return tabBar.hitTest(convert(point, to: tabBar), with: event)
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
    guard let item = itemsByTab[selectedTab], tabBar.items?.contains(item) == true else { return }
    guard tabBar.selectedItem !== item else { return }
    tabBar.selectedItem = item
  }

  func tabBar(_ tabBar: UITabBar, didSelect item: UITabBarItem) {
    guard tabs.indices.contains(item.tag) else { return }
    onSelectionChange(["tab": tabs[item.tag]])
  }
}
