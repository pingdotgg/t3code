import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import T3.Shell

// Frameless window chrome: drag anywhere, double-click to maximize, window
// buttons on the platform's usual side.
Rectangle {
    id: bar

    required property Window window

    readonly property bool controlsOnLeft: Qt.platform.os === "osx"
    readonly property color foreground: Theme.color("text", "#e4e4e7")
    readonly property color hover: Theme.color("surfaceRaised", "#27272a")

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

    component WindowButton: AbstractButton {
        id: button

        required property string glyph
        property color tint: bar.foreground

        implicitWidth: 40
        implicitHeight: bar.implicitHeight
        Accessible.role: Accessible.Button
        Accessible.name: text

        background: Rectangle {
            color: button.hovered ? bar.hover : "transparent"
        }

        contentItem: Text {
            text: button.glyph
            color: button.tint
            font.pixelSize: 13
            horizontalAlignment: Text.AlignHCenter
            verticalAlignment: Text.AlignVCenter
        }
    }

    component WindowControls: Row {
        id: controls

        required property var order

        Repeater {
            model: controls.order

            WindowButton {
                required property string modelData

                glyph: modelData === "close" ? "✕" : modelData === "minimize" ? "–" : bar.window.visibility === Window.Maximized ? "❐" : "□"
                text: modelData === "close" ? qsTr("Close") : modelData === "minimize" ? qsTr("Minimize") : qsTr("Maximize")
                tint: modelData === "close" ? Theme.color("error", "#ef4444") : bar.foreground
                onClicked: {
                    if (modelData === "close") {
                        bar.window.close();
                    } else if (modelData === "minimize") {
                        bar.window.showMinimized();
                    } else {
                        bar.window.visibility === Window.Maximized ? bar.window.showNormal() : bar.window.showMaximized();
                    }
                }
            }
        }
    }

    RowLayout {
        anchors.fill: parent
        spacing: 0

        WindowControls {
            visible: bar.controlsOnLeft
            order: ["close", "minimize", "maximize"]
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
            order: ["minimize", "maximize", "close"]
        }
    }
}
