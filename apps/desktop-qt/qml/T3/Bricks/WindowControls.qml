import QtQuick
import QtQuick.Controls.Basic
import T3.Shell

// Minimize / maximize / close for a frameless window, in the order the
// platform expects (the caller picks the side).
Row {
    id: controls

    required property Window window
    property var order: Qt.platform.os === "osx" ? ["close", "minimize", "maximize"] : ["minimize", "maximize", "close"]
    property real buttonWidth: 40
    property real buttonHeight: 36
    readonly property color foreground: Theme.color("text", "#e4e4e7")

    Repeater {
        model: controls.order

        AbstractButton {
            id: button

            required property string modelData

            readonly property bool isClose: modelData === "close"

            width: controls.buttonWidth
            height: controls.buttonHeight
            hoverEnabled: true
            text: isClose ? qsTr("Close") : modelData === "minimize" ? qsTr("Minimize") : qsTr("Maximize")
            Accessible.role: Accessible.Button
            Accessible.name: text
            onClicked: {
                if (isClose) {
                    controls.window.close();
                } else if (modelData === "minimize") {
                    controls.window.showMinimized();
                } else {
                    controls.window.visibility === Window.Maximized ? controls.window.showNormal() : controls.window.showMaximized();
                }
            }

            background: Rectangle {
                radius: 6
                color: button.hovered ? (button.isClose ? Theme.color("error", "#ef4444") : Theme.color("accentSurface", "#27272a")) : "transparent"

                Behavior on color {
                    ColorAnimation {
                        duration: 120
                    }
                }
            }

            contentItem: Item {
                ShellIcon {
                    anchors.centerIn: parent
                    name: button.isClose ? "x" : button.modelData === "minimize" ? "minus" : controls.window.visibility === Window.Maximized ? "copy" : "square"
                    size: button.isClose ? 14 : 12
                    color: button.isClose && button.hovered ? Theme.color("errorForeground", "#ffffff") : controls.foreground
                }
            }
        }
    }
}
