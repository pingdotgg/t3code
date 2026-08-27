import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import T3.Shell

MenuItem {
    id: control

    property bool destructive: false
    property string iconName: ""
    // A trailing check mark, for menus that show the current choice.
    property bool current: false

    implicitHeight: 28
    leftPadding: 8
    rightPadding: 8
    font.family: Theme.fontUi.length > 0 ? Theme.fontUi : Qt.application.font.family
    font.pixelSize: 14
    hoverEnabled: true

    contentItem: RowLayout {
        spacing: 8

        ShellIcon {
            visible: control.iconName.length > 0
            name: control.iconName
            size: 16
            color: Qt.alpha(Theme.color("textMuted", "#8b8b93"), 0.8)
            Layout.alignment: Qt.AlignVCenter
        }

        Text {
            text: control.text
            font: control.font
            color: control.destructive ? Theme.color("error", "#ef4444") : Theme.color("text", "#e4e4e7")
            opacity: control.enabled ? 1 : 0.5
            verticalAlignment: Text.AlignVCenter
            elide: Text.ElideRight
            Layout.fillWidth: true
        }

        ShellIcon {
            visible: control.current
            name: "check"
            size: 14
            color: Theme.color("text", "#e4e4e7")
            Layout.alignment: Qt.AlignVCenter
        }
    }

    background: Rectangle {
        radius: 6
        color: control.highlighted || control.hovered ? Theme.color("accentSurface", "#27272a") : "transparent"
    }
}
