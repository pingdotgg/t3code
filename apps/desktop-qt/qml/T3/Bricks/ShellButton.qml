import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import T3.Shell

// A button in the page's clothes. Outline by default (the header pills),
// `subtle` for the ghost buttons, `primary` for the accent one; `iconName` is a
// lucide id drawn before the text, `chevron` appends the menu chevron.
Button {
    id: control

    property bool primary: false
    property bool subtle: false
    property bool chevron: false
    property string iconName: ""
    property real iconSize: 14
    property real chevronSize: 14
    property color tint: primary ? Theme.color("accentForeground", "#ffffff") : Theme.color("text", "#e4e4e7")
    property color iconTint: tint
    property real radius: Math.min(Theme.radius, 8)
    readonly property bool iconOnly: text.length === 0 && iconName.length > 0 && !chevron
    readonly property color hoverFill: Qt.alpha(Theme.color("accentSurface", "#27272a"), control.subtle ? 1 : 0.5)

    implicitHeight: 28
    leftPadding: iconOnly ? (implicitHeight - iconSize) / 2 : 8
    rightPadding: iconOnly ? (implicitHeight - iconSize) / 2 : chevron && text.length === 0 && iconName.length === 0 ? 5 : 8
    font.family: Theme.fontUi.length > 0 ? Theme.fontUi : Qt.application.font.family
    font.pixelSize: 13
    font.weight: Font.Medium
    hoverEnabled: true
    scale: down ? 0.97 : 1
    opacity: enabled ? 1 : 0.64

    Behavior on scale {
        NumberAnimation {
            duration: 100
            easing.type: Easing.OutCubic
        }
    }

    background: Rectangle {
        radius: control.radius
        color: control.primary ? (control.down ? Qt.darker(Theme.color("accent", "#2563eb"), 1.15) : control.hovered ? Qt.lighter(Theme.color("accent", "#2563eb"), 1.08) : Theme.color("accent", "#2563eb")) : control.hovered || control.down || control.checked ? control.hoverFill : control.subtle ? "transparent" : Qt.alpha(Theme.color("input", "#27272a"), 0.32)
        border.color: control.primary || control.subtle ? "transparent" : Theme.color("input", "#27272a")
        border.width: control.primary || control.subtle ? 0 : 1

        Behavior on color {
            ColorAnimation {
                duration: 120
            }
        }
    }

    contentItem: RowLayout {
        spacing: 6

        ShellIcon {
            visible: control.iconName.length > 0
            name: control.iconName
            size: control.iconSize
            color: control.iconTint
            Layout.alignment: Qt.AlignVCenter
        }

        Text {
            visible: control.text.length > 0
            text: control.text
            font: control.font
            color: control.tint
            elide: Text.ElideRight
            verticalAlignment: Text.AlignVCenter
            Layout.fillWidth: true
            Layout.minimumWidth: 0
        }

        ShellIcon {
            visible: control.chevron
            name: "chevron-down"
            size: control.chevronSize
            color: control.text.length > 0 || control.iconName.length > 0 ? Theme.color("iconMuted", "#8b8b93") : control.tint
            Layout.alignment: Qt.AlignVCenter
        }
    }
}
