import QtQuick
import QtQuick.Controls.Basic
import T3.Shell

// A popup menu in the page's clothes; use ShellMenuItem for entries.
Menu {
    id: control

    padding: 4
    implicitWidth: 200

    enter: Transition {
        NumberAnimation {
            property: "opacity"
            from: 0
            to: 1
            duration: 120
            easing.type: Easing.OutCubic
        }
    }

    exit: Transition {
        NumberAnimation {
            property: "opacity"
            from: 1
            to: 0
            duration: 90
        }
    }

    background: Rectangle {
        radius: Math.min(Theme.radius, 10)
        color: Theme.color("surfaceOverlay", "#18181b")
        border.color: Qt.alpha(Theme.color("text", "#e4e4e7"), 0.1)
        border.width: 1
    }
}
