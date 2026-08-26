import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import T3.Shell

// The workspace strip: project / thread breadcrumb, checkout context and
// branch, open-in-editor and project scripts, from Shell.state.workspace.
// Git commit/push/PR actions stay with the page's own control.
Rectangle {
    id: strip

    readonly property var model: Shell.state.workspace ?? null
    readonly property bool ready: model !== null
    readonly property color foreground: Theme.color("toolbarForeground", "#e4e4e7")
    readonly property color muted: Theme.color("textMuted", "#8b8b93")
    readonly property string gitSummary: {
        if (!ready || !model.git || !model.git.isRepo) {
            return "";
        }
        const parts = [];
        if (model.git.hasWorkingTreeChanges) {
            parts.push(qsTr("modified"));
        }
        if (model.git.aheadCount > 0) {
            parts.push("↑" + model.git.aheadCount);
        }
        if (model.git.behindCount > 0) {
            parts.push("↓" + model.git.behindCount);
        }
        return parts.join(" ");
    }

    implicitHeight: 40
    color: Theme.color("toolbar", "#0f0f12")

    RowLayout {
        anchors.fill: parent
        anchors.leftMargin: 12
        anchors.rightMargin: 12
        spacing: 8

        ToolButton {
            visible: strip.ready && strip.model.projectTitle !== null
            text: strip.ready ? (strip.model.projectTitle ?? "") : ""
            font.pixelSize: 13
            Accessible.name: qsTr("New thread in project")
            onClicked: Shell.dispatch("workspace.newThread")
        }

        Text {
            visible: strip.ready && strip.model.projectTitle !== null
            text: "/"
            color: strip.muted
        }

        Text {
            Layout.fillWidth: true
            text: strip.ready ? strip.model.threadTitle : qsTr("No thread")
            color: strip.foreground
            font.pixelSize: 13
            font.bold: true
            elide: Text.ElideRight
        }

        ComboBox {
            visible: strip.ready && strip.model.envModeChangeable
            Layout.preferredWidth: 170
            model: [qsTr("Current checkout"), qsTr("New worktree")]
            currentIndex: strip.ready && strip.model.envMode === "worktree" ? 1 : 0
            onActivated: index => Shell.dispatch("workspace.envMode.set", {
                    mode: index === 1 ? "worktree" : "local"
                })
        }

        Text {
            visible: strip.ready && !strip.model.envModeChangeable
            text: strip.ready ? strip.model.envModeLabel : ""
            color: strip.muted
            font.pixelSize: 12
        }

        Text {
            visible: strip.ready && strip.model.branch !== null
            text: strip.ready ? "⎇ " + (strip.model.branch ?? "") + (strip.gitSummary.length > 0 ? "  " + strip.gitSummary : "") : ""
            color: strip.muted
            font.pixelSize: 12
            elide: Text.ElideMiddle
            Layout.maximumWidth: 260
        }

        ToolButton {
            visible: strip.ready && strip.model.canOpenPullRequest
            text: strip.ready && strip.model.git && strip.model.git.pullRequest ? "#" + strip.model.git.pullRequest.number : ""
            font.pixelSize: 12
            Accessible.name: qsTr("Open pull request")
            onClicked: Shell.dispatch("workspace.openPullRequest")
        }

        ToolButton {
            id: scriptsButton

            visible: strip.ready && strip.model.scripts.length > 0
            text: qsTr("Run")
            onClicked: scriptsMenu.open()

            Menu {
                id: scriptsMenu

                y: parent.height

                Repeater {
                    model: strip.ready ? strip.model.scripts : []

                    MenuItem {
                        required property var modelData

                        text: modelData.name
                        onTriggered: Shell.dispatch("workspace.runScript", {
                            scriptId: modelData.id
                        })
                    }
                }
            }
        }

        ToolButton {
            id: openButton

            visible: strip.ready && strip.model.editors.length > 0
            text: qsTr("Open")
            onClicked: Shell.dispatch("workspace.openInEditor", {})
        }

        ToolButton {
            visible: openButton.visible
            text: "▾"
            Accessible.name: qsTr("Choose editor")
            onClicked: editorsMenu.open()

            Menu {
                id: editorsMenu

                y: parent.height

                Repeater {
                    model: strip.ready ? strip.model.editors : []

                    MenuItem {
                        required property var modelData

                        text: modelData.label + (strip.ready && modelData.id === strip.model.preferredEditorId ? " ✓" : "")
                        onTriggered: Shell.dispatch("workspace.openInEditor", {
                            editorId: modelData.id
                        })
                    }
                }
            }
        }
    }
}
