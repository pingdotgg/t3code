import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import T3.Shell

// Shown when the user's shell.qml failed and the built-in shell took over.
Item {
    id: overlay

    readonly property bool hasError: Runtime.lastError.length > 0

    visible: hasError

    Rectangle {
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        anchors.margins: 16
        width: Math.min(overlay.width - 32, 520)
        height: content.implicitHeight + 24
        radius: 8
        color: Theme.color("surfaceOverlay", "#18181b")
        border.color: Theme.color("error", "#ef4444")
        border.width: 1

        ColumnLayout {
            id: content

            anchors.fill: parent
            anchors.margins: 12
            spacing: 8

            Label {
                Layout.fillWidth: true
                text: Runtime.usingUserShell ? qsTr("Shell warning") : qsTr("shell.qml failed — using the built-in shell")
                font.bold: true
                color: Theme.color("text", "#e4e4e7")
            }

            Label {
                Layout.fillWidth: true
                text: Runtime.lastError
                wrapMode: Text.Wrap
                font.family: "monospace"
                font.pixelSize: 12
                color: Theme.color("textMuted", "#a1a1aa")
            }

            RowLayout {
                Layout.fillWidth: true

                Label {
                    Layout.fillWidth: true
                    text: Runtime.userShellPath
                    elide: Text.ElideMiddle
                    font.pixelSize: 11
                    color: Theme.color("textMuted", "#a1a1aa")
                }

                ShellButton {
                    text: qsTr("Reload")
                    onClicked: Runtime.reload()
                }
            }
        }
    }
}
