import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import T3.Shell

// The git pill: quick action + menu, with the commit and
// default-branch dialogs rendered here from Shell.state.git. Progress and
// results are the page's toasts, shown by Notifications.
RowLayout {
    id: git

    readonly property var model: Shell.state.git ?? null
    readonly property bool ready: model !== null && model.available
    readonly property color muted: Theme.color("textMuted", "#8b8b93")
    readonly property color foreground: Theme.color("text", "#e4e4e7")

    // Icon-only pill, for narrow header strips.
    property bool compact: false

    spacing: 0
    visible: ready

    readonly property string quickIcon: {
        if (!ready) {
            return "git-commit-horizontal";
        }
        switch (model.quickAction.kind) {
        case "open_pr":
            return "git-pull-request";
        case "open_publish":
            return "cloud-upload";
        case "run_pull":
            return "git-merge";
        default:
            return model.quickAction.label.toLowerCase().indexOf("push") >= 0 ? "cloud-upload" : "git-commit-horizontal";
        }
    }

    ShellButton {
        implicitHeight: 24
        font.pixelSize: 12
        iconName: "git-branch"
        visible: git.ready && !git.model.isRepo
        enabled: git.ready && !git.model.initPending
        text: git.ready && git.model.initPending ? qsTr("Initializing…") : qsTr("Initialize Git")
        onClicked: Shell.dispatch("git.init")
    }

    ShellSplitButton {
        visible: git.ready && git.model.isRepo
        enabled: git.ready && !git.model.busy
        actionEnabled: git.ready && git.model.quickAction.disabledReason === null
        compact: git.compact
        iconName: git.quickIcon
        text: git.ready ? git.model.quickAction.label : ""
        toolTip: git.ready ? (git.model.quickAction.disabledReason ?? "") : ""
        onClicked: Shell.dispatch("git.quick")
        onMenuRequested: {
            Shell.dispatch("git.refresh");
            menu.open();
        }

        ShellMenu {
            id: menu

            y: parent.height + 4
            x: parent.width - width

            Instantiator {
                model: git.ready ? git.model.menu : []

                delegate: ShellMenuItem {
                    required property var modelData
                    required property int index

                    text: modelData.disabledReason ? modelData.label + "  · " + modelData.disabledReason : modelData.label
                    enabled: modelData.disabledReason === null
                    onTriggered: {
                        if (modelData.id === "commit") {
                            commitDialog.reset();
                            commitDialog.open();
                        } else {
                            Shell.dispatch("git.menu", {
                                id: modelData.id
                            });
                        }
                    }
                }

                onObjectAdded: (index, object) => menu.insertItem(index, object)
                onObjectRemoved: (index, object) => menu.removeItem(object)
            }

            ShellMenuItem {
                visible: git.ready && git.model.canPublish
                height: visible ? implicitHeight : 0
                text: qsTr("Publish repository…")
                iconName: "cloud-upload"
                onTriggered: Shell.dispatch("git.publish")
            }

            Instantiator {
                model: git.ready ? git.model.hints : []

                delegate: ShellMenuItem {
                    required property var modelData

                    text: modelData
                    enabled: false
                }

                onObjectAdded: (index, object) => menu.addItem(object)
                onObjectRemoved: (index, object) => menu.removeItem(object)
            }
        }
    }

    // ---- Commit dialog -------------------------------------------------
    Popup {
        id: commitDialog

        property var excluded: ({})

        function reset() {
            message.text = "";
            excluded = {};
        }
        function selectedPaths() {
            const all = git.model.files.map(file => file.path);
            const chosen = all.filter(path => !commitDialog.excluded[path]);
            return chosen.length === all.length ? null : chosen;
        }
        function submit(featureBranch) {
            const paths = selectedPaths();
            if (paths !== null && paths.length === 0) {
                return;
            }
            Shell.dispatch("git.commit", {
                message: message.text,
                filePaths: paths,
                featureBranch: featureBranch
            });
            close();
        }

        parent: Overlay.overlay
        x: Math.round((parent.width - width) / 2)
        y: Math.round((parent.height - height) / 2)
        width: 520
        modal: true
        padding: 16

        background: Rectangle {
            radius: Theme.radius
            color: Theme.color("surfaceOverlay", "#18181b")
            border.color: Theme.color("border", "#27272a")
            border.width: 1
        }

        contentItem: ColumnLayout {
            spacing: 10

            Text {
                text: qsTr("Commit changes")
                color: git.foreground
                font.pixelSize: 15
                font.bold: true
            }

            Text {
                Layout.fillWidth: true
                text: qsTr("Review and confirm your commit. Leave the message blank to auto-generate one.")
                color: git.muted
                font.pixelSize: 12
                wrapMode: Text.Wrap
            }

            Text {
                visible: git.ready && git.model.isDefaultRef
                text: qsTr("Warning: committing on the default branch %1").arg(git.ready ? (git.model.branch ?? "") : "")
                color: Theme.color("warning", "#e0af68")
                font.pixelSize: 12
            }

            ListView {
                id: fileList

                Layout.fillWidth: true
                Layout.preferredHeight: Math.min(Math.max(count, 1) * 30, 220)
                clip: true
                model: git.ready ? git.model.files : []
                boundsBehavior: Flickable.StopAtBounds

                delegate: RowLayout {
                    required property var modelData

                    width: fileList.width
                    height: 30
                    spacing: 8

                    CheckBox {
                        checked: !commitDialog.excluded[modelData.path]
                        onToggled: {
                            const next = Object.assign({}, commitDialog.excluded);
                            if (checked) {
                                delete next[modelData.path];
                            } else {
                                next[modelData.path] = true;
                            }
                            commitDialog.excluded = next;
                        }
                    }

                    Text {
                        Layout.fillWidth: true
                        text: modelData.path
                        color: git.foreground
                        font.pixelSize: 12
                        elide: Text.ElideMiddle
                    }

                    Text {
                        text: "+" + modelData.insertions
                        color: Theme.color("update", "#22c55e")
                        font.pixelSize: 11
                    }

                    Text {
                        text: "−" + modelData.deletions
                        color: Theme.color("error", "#ef4444")
                        font.pixelSize: 11
                    }
                }
            }

            Rectangle {
                Layout.fillWidth: true
                implicitHeight: 84
                radius: Theme.radius
                color: Theme.color("input", "#141416")
                border.color: message.activeFocus ? Theme.color("focus", "#3b82f6") : Theme.color("border", "#27272a")

                ScrollView {
                    anchors.fill: parent
                    anchors.margins: 8

                    TextArea {
                        id: message

                        placeholderText: qsTr("Commit message (optional)")
                        placeholderTextColor: git.muted
                        color: git.foreground
                        wrapMode: TextEdit.Wrap
                        background: null
                        font.pixelSize: 13
                    }
                }
            }

            RowLayout {
                Layout.fillWidth: true
                spacing: 6

                Item {
                    Layout.fillWidth: true
                }

                ShellButton {
                    text: qsTr("Cancel")
                    onClicked: commitDialog.close()
                }

                ShellButton {
                    text: qsTr("Commit on new branch")
                    onClicked: commitDialog.submit(true)
                }

                ShellButton {
                    primary: true
                    text: qsTr("Commit")
                    onClicked: commitDialog.submit(false)
                }
            }
        }
    }

    // ---- Default-branch confirmation ---------------------------------
    Popup {
        id: confirmDialog

        readonly property var pending: git.ready ? git.model.pendingDefaultBranch : null

        parent: Overlay.overlay
        x: Math.round((parent.width - width) / 2)
        y: Math.round((parent.height - height) / 2)
        width: 460
        modal: true
        padding: 16
        visible: pending !== null
        closePolicy: Popup.NoAutoClose

        background: Rectangle {
            radius: Theme.radius
            color: Theme.color("surfaceOverlay", "#18181b")
            border.color: Theme.color("border", "#27272a")
            border.width: 1
        }

        contentItem: ColumnLayout {
            spacing: 10

            Text {
                Layout.fillWidth: true
                text: confirmDialog.pending ? confirmDialog.pending.title : ""
                color: git.foreground
                font.pixelSize: 15
                font.bold: true
                wrapMode: Text.Wrap
            }

            Text {
                Layout.fillWidth: true
                text: confirmDialog.pending ? confirmDialog.pending.description : ""
                color: git.muted
                font.pixelSize: 12
                wrapMode: Text.Wrap
            }

            RowLayout {
                Layout.fillWidth: true
                spacing: 6

                Item {
                    Layout.fillWidth: true
                }

                ShellButton {
                    text: qsTr("Abort")
                    onClicked: Shell.dispatch("git.defaultBranch", {
                        choice: "abort"
                    })
                }

                ShellButton {
                    text: confirmDialog.pending ? confirmDialog.pending.featureBranchLabel : ""
                    onClicked: Shell.dispatch("git.defaultBranch", {
                        choice: "featureBranch"
                    })
                }

                ShellButton {
                    primary: true
                    text: confirmDialog.pending ? confirmDialog.pending.continueLabel : ""
                    onClicked: Shell.dispatch("git.defaultBranch", {
                        choice: "continue"
                    })
                }
            }
        }
    }
}
