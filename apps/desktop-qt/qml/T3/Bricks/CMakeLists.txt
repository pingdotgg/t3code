# Pure-QML bricks. The qmldir is hand-written (no `prefer` line) so the same
# directory works both compiled into the binary and as a disk import path for
# hot reload.
qt_add_qml_module(t3bricks
  URI T3.Bricks
  VERSION 1.0
  STATIC
  NO_GENERATE_QMLDIR
  NO_PLUGIN_OPTIONAL
  QML_FILES
    Composer.qml
    DefaultShell.qml
    RightPanel.qml
    SettingsNav.qml
    ShellErrorOverlay.qml
    ShellButton.qml
    ShellComboBox.qml
    ShellMenu.qml
    ShellMenuItem.qml
    ShellTextField.qml
    Sidebar.qml
    SidebarThreadRow.qml
    TitleBar.qml
    WebProfile.qml
    WebSurface.qml
    Workspace.qml
  RESOURCES
    qmldir
    js/shell-connect.js
)
