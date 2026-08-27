import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import T3.Shell

// Settings navigation: sections, search, and a way back. The settings pages
// stay HTML in the primary web surface; this only drives navigation.
Rectangle {
    id: nav

    readonly property var model: Shell.state.settings ?? null
    readonly property bool active: model !== null && model.active
    readonly property color foreground: Theme.color("sidebarForeground", "#e4e4e7")
    readonly property color muted: Theme.color("sidebarMutedForeground", "#8b8b93")

    implicitWidth: 260
    color: Theme.color("sidebar", "#0a0a0a")

    ColumnLayout {
        anchors.fill: parent
        spacing: 0

        RowLayout {
            Layout.fillWidth: true
            Layout.margins: 10
            Layout.bottomMargin: 4
            spacing: 8

            ShellButton {
                subtle: true
                text: "←"
                Accessible.name: qsTr("Back")
                onClicked: Shell.dispatch("settings.back")
            }

            Label {
                Layout.fillWidth: true
                text: qsTr("Settings")
                color: nav.foreground
                font.bold: true
            }
        }

        ShellTextField {
            id: search

            Layout.fillWidth: true
            Layout.leftMargin: 10
            Layout.rightMargin: 10
            Layout.bottomMargin: 6
            placeholderText: qsTr("Search settings")
            text: nav.model ? nav.model.searchQuery : ""
            onTextEdited: Shell.dispatch("settings.search", {
                query: text
            })
            Keys.onEscapePressed: {
                text = "";
                Shell.dispatch("settings.search", {
                    query: ""
                });
            }
        }

        ListView {
            id: list

            readonly property bool searching: nav.model !== null && nav.model.searchQuery.trim().length > 0

            Layout.fillWidth: true
            Layout.fillHeight: true
            Layout.topMargin: 8
            clip: true
            boundsBehavior: Flickable.StopAtBounds
            model: nav.model === null ? [] : searching ? nav.model.searchResults : nav.model.sections

            delegate: Item {
                id: row

                required property var modelData

                readonly property bool isResult: list.searching
                readonly property bool current: !isResult && nav.model.activeSection === modelData.to

                width: ListView.view.width
                implicitHeight: isResult ? 48 : 36

                Rectangle {
                    anchors.fill: parent
                    anchors.leftMargin: 6
                    anchors.rightMargin: 6
                    radius: 6
                    color: row.current ? Theme.color("sidebarRowSelected", "#2a2a30") : hover.hovered ? Theme.color("sidebarRowHover", "#1c1c21") : "transparent"
                }

                HoverHandler {
                    id: hover
                }

                TapHandler {
                    onTapped: row.isResult ? Shell.dispatch("settings.openResult", {
                        to: row.modelData.to,
                        targetId: row.modelData.targetId
                    }) : Shell.dispatch("settings.navigate", {
                        to: row.modelData.to
                    })
                }

                ColumnLayout {
                    anchors.fill: parent
                    anchors.leftMargin: 16
                    anchors.rightMargin: 16
                    spacing: 1

                    Text {
                        Layout.fillWidth: true
                        text: row.isResult ? row.modelData.title : row.modelData.label
                        color: nav.foreground
                        font.pixelSize: 13
                        elide: Text.ElideRight
                    }

                    Text {
                        Layout.fillWidth: true
                        visible: row.isResult
                        text: row.isResult ? row.modelData.sectionLabel : ""
                        color: nav.muted
                        font.pixelSize: 11
                        elide: Text.ElideRight
                    }
                }
            }

            Text {
                anchors.centerIn: parent
                visible: list.searching && list.count === 0
                text: qsTr("No matching settings")
                color: nav.muted
                font.pixelSize: 12
            }
        }
    }
}
