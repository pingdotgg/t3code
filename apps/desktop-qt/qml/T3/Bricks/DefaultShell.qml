import QtQuick
import QtQuick.Layouts
import T3.Shell
import T3.Bricks

// Built-in layout. A user's ~/.t3/shell/shell.qml replaces this file
// wholesale; it is also the fallback when that file fails to load.
Window {
    id: root

    readonly property color chromeColor: Theme.color("chrome", "#0b0b0d")

    width: 1280
    height: 820
    minimumWidth: 640
    minimumHeight: 400
    visible: true
    title: qsTr("T3 Code")
    color: Theme.windowTransparent ? "transparent" : chromeColor
    opacity: Theme.windowOpacity
    flags: Theme.frameless ? Qt.Window | Qt.FramelessWindowHint : Qt.Window

    ColumnLayout {
        anchors.fill: parent
        spacing: 0

        TitleBar {
            Layout.fillWidth: true
            visible: Theme.frameless
            window: root
        }

        RowLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            spacing: 0

            Sidebar {
                Layout.fillHeight: true
                Layout.preferredWidth: 260
                visible: !settingsNav.active
            }

            SettingsNav {
                id: settingsNav

                Layout.fillHeight: true
                Layout.preferredWidth: 260
                visible: active
            }

            ColumnLayout {
                Layout.fillWidth: true
                Layout.fillHeight: true
                spacing: 0

                Workspace {
                    Layout.fillWidth: true
                    visible: ready
                }

                WebSurface {
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    url: Shell.pageUrl
                }

                Composer {
                    Layout.fillWidth: true
                    visible: ready
                }
            }

            RightPanel {
                Layout.fillHeight: true
                Layout.preferredWidth: implicitWidth
                visible: available
            }
        }
    }

    Notifications {
        anchors.bottom: parent.bottom
        anchors.right: parent.right
        anchors.bottomMargin: 180
        anchors.rightMargin: 16
    }

    ContextMenuHost {
        surfaceId: "shell"
    }

    ShellErrorOverlay {
        anchors.fill: parent
    }

    Connections {
        target: Shell
        function onWindowCommandRequested(command) {
            switch (command) {
            case "minimize":
                root.showMinimized();
                break;
            case "maximize":
                root.visibility === Window.Maximized ? root.showNormal() : root.showMaximized();
                break;
            case "close":
                root.close();
                break;
            case "move":
                root.startSystemMove();
                break;
            }
        }
    }
}
