import QtQuick
import QtTest
import T3.Shell
import "../qml/T3/Bricks"

Item {
    id: root
    width: 1200
    height: 100

    Component {
        id: workspaceComponent
        Workspace {
            width: 1100
            height: 52
        }
    }

    TestCase {
        name: "WorkspaceTests"
        when: windowShown

        function cleanup() {
            Shell.reset();
        }

        function test_titleUsesAvailableSpace_data() {
            return [
                {
                    tag: "draft",
                    title: qsTr("New thread")
                },
                {
                    tag: "thread",
                    title: qsTr("Fix TUI Readability Issue")
                },
                {
                    tag: "long",
                    title: qsTr("Review the desktop shell and its shared widgets")
                }
            ];
        }

        function test_titleUsesAvailableSpace(data) {
            Shell.state = {
                workspace: {
                    projectTitle: qsTr("Project"),
                    threadTitle: data.title,
                    isDraft: false,
                    renameRequestId: 0,
                    scripts: [],
                    editors: [],
                    terminalAvailable: false
                }
            };
            let workspace = createTemporaryObject(workspaceComponent, root);
            verify(!!workspace, "Component exists");
            let label = findChild(workspace, "threadLabel");
            verify(!!label, "Object exists");
            verify(waitForRendering(workspace));
            compare(label.truncated, false);
            workspace.width = 160;
            tryCompare(label, "truncated", true);
            workspace.width = 1100;
            tryCompare(label, "truncated", false);
        }
    }
}
