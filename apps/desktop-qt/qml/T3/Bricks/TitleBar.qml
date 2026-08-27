import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import T3.Shell

// Frameless window chrome for rices that want a separate title row: drag
// anywhere, double-click to maximize, window buttons on the platform's usual
// side. DefaultShell folds these into its header strip instead.
Rectangle {
    id: bar

    required property Window window

    readonly property bool controlsOnLeft: Qt.platform.os === "osx"
    readonly property color foreground: Theme.color("text", "#e4e4e7")

    implicitHeight: 38
    color: Theme.color("chrome", "#141416")

    DragHandler {
        target: null
        grabPermissions: PointerHandler.CanTakeOverFromAnything
        onActiveChanged: if (active)
            bar.window.startSystemMove()
    }

    TapHandler {
        onDoubleTapped: bar.window.visibility === Window.Maximized ? bar.window.showNormal() : bar.window.showMaximized()
    }

    RowLayout {
        anchors.fill: parent
        spacing: 0

        WindowControls {
            visible: bar.controlsOnLeft
            window: bar.window
            buttonHeight: bar.implicitHeight
        }

        Label {
            Layout.fillWidth: true
            Layout.leftMargin: 12
            Layout.rightMargin: 12
            text: bar.window.title
            color: bar.foreground
            elide: Text.ElideRight
            horizontalAlignment: Text.AlignHCenter
        }

        WindowControls {
            visible: !bar.controlsOnLeft
            window: bar.window
            buttonHeight: bar.implicitHeight
        }
    }
}
