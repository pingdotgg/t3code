import UIKit

/// Real, accessible controls own palette interaction. UIKit calls the pending
/// action only after dismissal, so opening another sheet cannot race this one.
@MainActor
final class FeatureCommandPaletteController: UIViewController,
    UITableViewDataSource, UITableViewDelegate, UITextFieldDelegate, UIAdaptivePresentationControllerDelegate {
    private let dispatcher: FeatureKeyboardDispatcher
    private let didFinish: ((@MainActor () -> Void)?) -> Void
    private let input = UITextField()
    private let table: UITableView
    private var results: [FeatureCommandPaletteItem] = []
    private var selectedID: String?
    private var isClosing = false
    private var didReportDismissal = false
    private var isSearching: Bool?
    private var pendingAction: (@MainActor () -> Void)?

    init(
        dispatcher: FeatureKeyboardDispatcher,
        table: UITableView? = nil,
        onDismiss: @escaping ((@MainActor () -> Void)?) -> Void
    ) {
        self.dispatcher = dispatcher
        self.table = table ?? UITableView(frame: .zero, style: .plain)
        self.didFinish = onDismiss
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        overrideUserInterfaceStyle = .dark
        view.accessibilityViewIsModal = true
        presentationController?.delegate = self

        input.placeholder = "Search commands, projects, and threads"
        input.accessibilityLabel = "Search commands, projects, and threads"
        input.accessibilityIdentifier = "command-palette-search"
        input.textColor = .white
        input.font = .preferredFont(forTextStyle: .body)
        input.adjustsFontForContentSizeCategory = true
        input.autocapitalizationType = .none
        input.autocorrectionType = .no
        input.clearButtonMode = .whileEditing
        input.returnKeyType = .go
        input.delegate = self
        input.addTarget(self, action: #selector(queryChanged), for: .editingChanged)

        let close = UIButton(type: .system)
        close.setImage(UIImage(systemName: "xmark"), for: .normal)
        close.tintColor = .white
        close.accessibilityLabel = "Close command palette"
        close.addTarget(self, action: #selector(closePalette), for: .touchUpInside)
        close.widthAnchor.constraint(equalToConstant: 44).isActive = true
        close.heightAnchor.constraint(equalToConstant: 44).isActive = true
        let header = UIStackView(arrangedSubviews: [input, close])
        header.alignment = .center
        header.spacing = 8

        table.backgroundColor = .black
        table.separatorColor = .darkGray
        table.rowHeight = UITableView.automaticDimension
        table.estimatedRowHeight = 56
        table.dataSource = self
        table.delegate = self
        table.keyboardDismissMode = .none
        table.register(UITableViewCell.self, forCellReuseIdentifier: "command")
        for child in [header, table] {
            child.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(child)
        }
        NSLayoutConstraint.activate([
            header.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            header.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            header.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -8),
            header.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
            table.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 8),
            table.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            table.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            table.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
        ])
        reloadResults()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if !isClosing { input.becomeFirstResponder() }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if !isClosing && (isBeingDismissed || presentingViewController == nil) {
            finish()
        }
    }

    private var selectedIndex: Int {
        results.firstIndex { $0.id == selectedID } ?? 0
    }

    func reloadResults(resetSelection: Bool = false) {
        guard isViewLoaded, !isClosing else { return }
        let content = dispatcher.content()
        var next = FeatureCommandPaletteSearch.results(in: content, query: input.text ?? "")
        if !resetSelection {
            // Streaming updates can change updatedAt. Keep existing matches in
            // place until the query changes, and append newly available ones.
            let byID = Dictionary(next.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            let previousIDs = Set(results.map(\.id))
            next = results.compactMap { byID[$0.id] } + next.filter { !previousIDs.contains($0.id) }
        }
        let unchanged = isSearching == content.isSearching && results.elementsEqual(next) {
            $0.id == $1.id && $0.kind == $1.kind && $0.title == $1.title && $0.detail == $1.detail
        }
        // Refresh action closures even when no visible content changed.
        results = next
        isSearching = content.isSearching
        if resetSelection { selectedID = nil }
        guard !unchanged || resetSelection else { return }
        table.reloadData()
        if results.isEmpty {
            selectedID = nil
            let label = UILabel()
            label.text = content.isSearching ? "Searching…" : "No results"
            label.textColor = .white
            label.textAlignment = .center
            label.font = .preferredFont(forTextStyle: .body)
            table.backgroundView = label
        } else {
            table.backgroundView = nil
            select(index: selectedIndex, scroll: resetSelection)
        }
    }

    @objc private func queryChanged() {
        dispatcher.search(input.text ?? "")
        reloadResults(resetSelection: true)
    }

    private func select(index: Int, scroll: Bool = true) {
        guard results.indices.contains(index) else { return }
        selectedID = results[index].id
        let path = IndexPath(row: index, section: 0)
        table.selectRow(at: path, animated: false, scrollPosition: .none)
        if scroll { table.scrollToRow(at: path, at: index == 0 ? .top : .middle, animated: false) }
    }

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { results.count }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let item = results[indexPath.row]
        let cell = tableView.dequeueReusableCell(withIdentifier: "command", for: indexPath)
        var content = cell.defaultContentConfiguration()
        content.text = item.title
        content.secondaryText = item.detail
        content.textProperties.color = .white
        content.secondaryTextProperties.color = .lightGray
        content.image = UIImage(systemName: item.kind == .thread ? "text.bubble" : item.kind == .project ? "folder" : "command")
        content.imageProperties.tintColor = .white
        cell.contentConfiguration = content
        cell.backgroundColor = .black
        let selected = UIView()
        selected.backgroundColor = UIColor(white: 0.16, alpha: 1)
        cell.selectedBackgroundView = selected
        cell.accessibilityTraits.insert(.button)
        if traitCollection.userInterfaceIdiom == .pad && indexPath.row < 9 {
            let shortcut = UILabel()
            shortcut.text = "⌘\(indexPath.row + 1)"
            shortcut.font = .preferredFont(forTextStyle: .footnote)
            shortcut.textColor = .lightGray
            shortcut.sizeToFit()
            cell.accessoryView = shortcut
        } else {
            cell.accessoryView = nil
        }
        return cell
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        run(index: indexPath.row)
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        guard input.markedTextRange == nil else { return true }
        run(index: selectedIndex)
        return false
    }

    override var keyCommands: [UIKeyCommand]? {
        guard input.markedTextRange == nil, !isClosing else { return [] }
        var commands = [
            key(UIKeyCommand.inputDownArrow, title: "Next Result"),
            key(UIKeyCommand.inputUpArrow, title: "Previous Result"),
            key(UIKeyCommand.inputEscape, title: "Close Command Palette"),
        ]
        if traitCollection.userInterfaceIdiom == .pad {
            commands.append(key("k", modifiers: .command, title: "Close Command Palette"))
            commands += results.prefix(9).enumerated().map { index, item in
                key(String(index + 1), modifiers: .command, title: item.title)
            }
        }
        return commands
    }

    private func key(_ input: String, modifiers: UIKeyModifierFlags = [], title: String) -> UIKeyCommand {
        let command = UIKeyCommand(input: input, modifierFlags: modifiers, action: #selector(handleKey(_:)))
        command.discoverabilityTitle = title
        command.wantsPriorityOverSystemBehavior = true
        return command
    }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(handleKey(_:)) { return !isClosing && input.markedTextRange == nil }
        return super.canPerformAction(action, withSender: sender)
    }

    @objc private func handleKey(_ sender: UIKeyCommand) {
        guard !isClosing, input.markedTextRange == nil else { return }
        switch sender.input {
        case UIKeyCommand.inputEscape, "k": closePalette()
        case UIKeyCommand.inputDownArrow, UIKeyCommand.inputUpArrow:
            select(index: FeatureCommandPaletteSearch.nextIndex(
                selectedIndex,
                direction: sender.input == UIKeyCommand.inputDownArrow ? 1 : -1,
                count: results.count
            ))
        default:
            if let number = sender.input.flatMap(Int.init) { run(index: number - 1) }
        }
    }

    private func run(index: Int) {
        guard results.indices.contains(index) else { return }
        close(action: results[index].run)
    }

    @objc private func closePalette() { close(action: nil) }

    func close(action: (@MainActor () -> Void)?) {
        // An incoming route supersedes an action whose dismissal is in flight.
        pendingAction = action
        guard !isClosing else { return }
        isClosing = true
        input.resignFirstResponder()
        dismiss(animated: true) { [weak self] in self?.finish() }
    }

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        finish()
    }

    private func finish() {
        guard !didReportDismissal else { return }
        didReportDismissal = true
        let action = pendingAction
        pendingAction = nil
        didFinish(action)
    }
}
