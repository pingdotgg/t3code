import UIKit

/// A frozen viewport lets UIKit provide selection handles without competing with
/// terminal scrolling or changing the remote shell's input.
final class TerminalTextSelectionViewController: UIViewController {
  private let text: String
  private let fontSize: CGFloat

  init(text: String, fontSize: CGFloat) {
    self.text = text
    self.fontSize = fontSize
    super.init(nibName: nil, bundle: nil)
  }

  required init?(coder: NSCoder) {
    return nil
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    title = "Terminal text"
    view.backgroundColor = .systemBackground

    navigationItem.leftBarButtonItem = UIBarButtonItem(
      title: "Copy All", style: .plain, target: self, action: #selector(copyAll))
    navigationItem.rightBarButtonItem = UIBarButtonItem(
      barButtonSystemItem: .done, target: self, action: #selector(close))

    let textView = UITextView()
    textView.text = text
    textView.font = .monospacedSystemFont(ofSize: max(fontSize, 14), weight: .regular)
    textView.textColor = .label
    textView.backgroundColor = .systemBackground
    textView.isEditable = false
    textView.isSelectable = true
    textView.accessibilityLabel = "Terminal output"
    textView.textContainerInset = UIEdgeInsets(top: 16, left: 12, bottom: 16, right: 12)
    textView.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(textView)

    NSLayoutConstraint.activate([
      textView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
      textView.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
      textView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
      textView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
    ])
  }

  @objc
  private func copyAll() {
    UIPasteboard.general.string = text
    close()
  }

  @objc
  private func close() {
    dismiss(animated: !UIAccessibility.isReduceMotionEnabled)
  }
}
