import QtQml

// Mirrors KWin 6.8, whose org.kde.kwin exports the Window type of Workspace.windows.
QtObject {
    property int pid
    property string caption
    property bool minimized
    property rect clientGeometry
    signal closed()
}
