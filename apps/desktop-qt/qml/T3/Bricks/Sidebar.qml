import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import T3.Shell

// The thread sidebar, rendered from the view model the web app publishes
// under Shell.state.sidebar (see packages/contracts/src/shell.ts). Every
// click is dispatched back to the page; nothing here talks to the server.
Rectangle {
    id: sidebar

    readonly property var model: Shell.state.sidebar ?? null
    readonly property var projects: model ? model.projects : []
    readonly property var rows: buildRows(model)
    readonly property color foreground: Theme.color("sidebarForeground", "#e4e4e7")
    readonly property color muted: Theme.color("sidebarMutedForeground", "#8b8b93")

    implicitWidth: 260
    color: Theme.color("sidebar", "#0a0a0a")

    function buildRows(state) {
        if (!state) {
            return [];
        }
        const out = [];
        const section = (label, items, kind) => {
            if (items.length === 0) {
                return;
            }
            out.push({
                kind: "header",
                label: label + " · " + items.length
            });
            for (const item of items) {
                out.push({
                    kind: kind,
                    item: item
                });
            }
        };
        section(qsTr("Drafts"), state.drafts, "draft");
        section(qsTr("Pinned"), state.pinned, "thread");
        section(qsTr("Threads"), state.active, "thread");
        section(qsTr("Snoozed"), state.snoozed, "thread");
        section(qsTr("Settled"), state.settled, "thread");
        if (state.settledTotal > state.settled.length) {
            out.push({
                kind: "header",
                label: qsTr("%1 more settled in the app").arg(state.settledTotal - state.settled.length)
            });
        }
        return out;
    }

    ColumnLayout {
        anchors.fill: parent
        spacing: 0

        RowLayout {
            Layout.fillWidth: true
            Layout.margins: 8
            spacing: 6

            ShellComboBox {
                id: scope

                Layout.fillWidth: true
                model: [qsTr("All projects")].concat(sidebar.projects.map(project => project.displayName))
                currentIndex: {
                    if (!sidebar.model || sidebar.model.scopeProjectKey === null) {
                        return 0;
                    }
                    const index = sidebar.projects.findIndex(project => project.key === sidebar.model.scopeProjectKey);
                    return index < 0 ? 0 : index + 1;
                }
                onActivated: index => Shell.dispatch("sidebar.scope", {
                        projectKey: index === 0 ? null : sidebar.projects[index - 1].key
                    })
            }

            ShellButton {
                subtle: true
                text: "+"
                font.pixelSize: 16
                Accessible.name: qsTr("New thread")
                onClicked: Shell.dispatch("thread.new", sidebar.model && sidebar.model.scopeProjectKey !== null ? {
                    projectKey: sidebar.model.scopeProjectKey
                } : {})
            }
        }

        ListView {
            id: list

            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            model: sidebar.rows
            reuseItems: true
            boundsBehavior: Flickable.StopAtBounds

            delegate: Item {
                id: entry

                required property var modelData

                readonly property bool isHeader: modelData.kind === "header"

                width: ListView.view.width
                implicitHeight: isHeader ? 30 : 44

                Text {
                    anchors.left: parent.left
                    anchors.bottom: parent.bottom
                    anchors.leftMargin: 14
                    anchors.bottomMargin: 6
                    visible: entry.isHeader
                    text: entry.isHeader ? entry.modelData.label : ""
                    color: sidebar.muted
                    font.pixelSize: 11
                    font.capitalization: Font.AllUppercase
                    font.letterSpacing: 0.6
                }

                Loader {
                    anchors.fill: parent
                    active: !entry.isHeader

                    sourceComponent: SidebarThreadRow {
                        item: entry.modelData.kind === "draft" ? {
                            title: entry.modelData.item.label,
                            status: "ready",
                            statusLabel: qsTr("Draft"),
                            unread: false
                        } : entry.modelData.item
                        active: sidebar.model !== null && (entry.modelData.kind === "draft" ? entry.modelData.item.draftId === sidebar.model.activeDraftId : entry.modelData.item.key === sidebar.model.activeThreadKey)
                        onActivated: entry.modelData.kind === "draft" ? Shell.dispatch("draft.open", {
                            draftId: entry.modelData.item.draftId
                        }) : Shell.dispatch("thread.open", {
                            key: entry.modelData.item.key
                        })
                    }
                }
            }

            Text {
                anchors.centerIn: parent
                visible: list.count === 0
                text: sidebar.model === null ? qsTr("Waiting for the app…") : sidebar.projects.length === 0 ? qsTr("No projects yet") : qsTr("No threads")
                color: sidebar.muted
                font.pixelSize: 12
            }
        }

        RowLayout {
            Layout.fillWidth: true
            Layout.margins: 6
            spacing: 2

            FooterButton {
                text: qsTr("Settings")
                onClicked: Shell.dispatch("settings.open")
            }

            FooterButton {
                text: qsTr("PRs")
                onClicked: Shell.dispatch("pullRequests.open")
            }

            FooterButton {
                text: qsTr("Usage")
                onClicked: Shell.dispatch("usage.open")
            }

            FooterButton {
                text: qsTr("Add")
                Accessible.name: qsTr("Add project")
                onClicked: Shell.dispatch("project.add")
            }
        }
    }

    component FooterButton: ShellButton {
        subtle: true
        Layout.fillWidth: true
        font.pixelSize: 12
    }
}
