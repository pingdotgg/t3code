import QtQuick
import QtQuick.Controls.Basic
import T3.Shell

// Minimize / maximize / close for a frameless window, in the order the
// platform expects (the caller picks the side). `trafficLights` swaps the
// glyph buttons for macOS-style dots that reveal their glyph on hover and go
// grey while the window is inactive.
Row {
    id: controls

    property Window window: null
    property var order: Qt.platform.os === "osx" ? ["close", "minimize", "maximize"] : ["minimize", "maximize", "close"]
    property bool trafficLights: false
    property real buttonWidth: trafficLights ? 12 : 40
    property real buttonHeight: trafficLights ? 12 : 36
    readonly property color foreground: Theme.color("text", "#e4e4e7")
    readonly property var lightColors: ({
            "close": "#ff5f57",
            "minimize": "#febc2e",
            "maximize": "#28c840"
        })

    spacing: trafficLights ? 8 : 0

    HoverHandler {
        id: hover

        enabled: controls.trafficLights
    }

    Repeater {
        model: controls.order

        AbstractButton {
            id: button

            required property string modelData

            readonly property bool isClose: modelData === "close"
            readonly property color light: controls.window === null || controls.window.active ? controls.lightColors[modelData] : Theme.color("mutedForeground", "#5b5b60")

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
                radius: controls.trafficLights ? height / 2 : 6
                color: controls.trafficLights ? button.light : button.hovered ? (button.isClose ? Theme.color("error", "#ef4444") : Theme.color("accentSurface", "#27272a")) : "transparent"
                border.width: controls.trafficLights ? 1 : 0
                border.color: Qt.darker(button.light, 1.25)

                Behavior on color {
                    ColorAnimation {
                        duration: 120
                    }
                }
            }

            contentItem: Item {
                ShellIcon {
                    anchors.centerIn: parent
                    name: button.isClose ? "x" : button.modelData === "minimize" ? "minus" : controls.trafficLights ? "plus" : controls.window !== null && controls.window.visibility === Window.Maximized ? "copy" : "square"
                    size: controls.trafficLights ? 8 : button.isClose ? 14 : 12
                    strokeWidth: controls.trafficLights ? 2.5 : 2
                    color: controls.trafficLights ? Qt.darker(button.light, 2.4) : button.isClose && button.hovered ? Theme.color("errorForeground", "#ffffff") : controls.foreground
                    visible: !controls.trafficLights || hover.hovered
                }
            }
        }
    }
}
