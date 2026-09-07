import QtQuick
import QtTest
import T3.Shell
import "../qml/T3/Bricks"

Item {
    id: root
    width: 400
    height: 500

    Component {
        id: sidebarComponent
        Sidebar {
            width: 272
            height: 450
            showScope: false
            showFooter: false
        }
    }

    TestCase {
        name: "SidebarTests"
        when: windowShown

        function init() {
            Shell.state = {
                sidebar: {
                    projects: [
                        {
                            key: "project",
                            displayName: qsTr("Project")
                        }
                    ],
                    scopeProjectKey: null,
                    activeThreadKey: null,
                    activeDraftId: null,
                    drafts: [],
                    pinned: [],
                    snoozed: [],
                    settled: [],
                    settledTotal: 0,
                    active: [
                        {
                            key: "thread",
                            projectKey: "project",
                            title: qsTr("Review"),
                            status: "working",
                            canSettle: true,
                            canSnooze: true,
                            branch: "main",
                            updatedAt: "2026-09-07T12:00:00Z"
                        }
                    ]
                }
            };
        }

        function cleanup() {
            Shell.reset();
        }

        function test_publicationKeepsHoveredRow() {
            let sidebar = createTemporaryObject(sidebarComponent, root);
            verify(!!sidebar, "Component exists");
            let list = findChild(sidebar, "list");
            verify(!!list, "Object exists");
            tryCompare(list, "count", 1);
            let row = findChild(sidebar, "threadRow:thread");
            verify(!!row, "Object exists");
            mouseMove(row, 100, 40);
            tryCompare(row, "showActions", true);
            const next = JSON.parse(JSON.stringify(Shell.state.sidebar));
            next.active[0].title = qsTr("Review updated");
            Shell.state = {
                sidebar: next
            };
            tryVerify(() => findChild(sidebar, "threadRow:thread").item.title === qsTr("Review updated"));
            compare(findChild(sidebar, "threadRow:thread"), row);
            tryCompare(row, "showActions", true);
        }

        function test_reorderParkFoldAndRemove() {
            let sidebar = createTemporaryObject(sidebarComponent, root);
            verify(!!sidebar, "Component exists");
            let list = findChild(sidebar, "list");
            verify(!!list, "Object exists");
            tryCompare(list, "count", 1);
            let row = findChild(sidebar, "threadRow:thread");
            verify(!!row, "Object exists");
            let next = JSON.parse(JSON.stringify(Shell.state.sidebar));
            next.active.unshift(Object.assign({}, next.active[0], {
                key: "second",
                title: qsTr("Second")
            }));
            Shell.state = {
                sidebar: next
            };
            tryCompare(list, "count", 2);
            compare(findChild(sidebar, "threadRow:thread"), row);

            next = JSON.parse(JSON.stringify(next));
            next.active.reverse();
            Shell.state = {
                sidebar: next
            };
            compare(findChild(sidebar, "threadRow:thread"), row);
            mouseClick(row, 100, 40);
            tryCompare(Shell, "dispatchCount", 1);
            compare(Shell.dispatchedActions[0].payload.key, "thread");

            next = JSON.parse(JSON.stringify(next));
            next.snoozed = [next.active.shift()];
            Shell.state = {
                sidebar: next
            };
            tryCompare(list, "count", 3);
            tryCompare(row, "slim", true);
            tryCompare(row, "section", "snoozed");
            sidebar.toggleSection("snoozed");
            tryCompare(list, "count", 2);
            sidebar.toggleSection("snoozed");
            tryCompare(list, "count", 3);

            next = JSON.parse(JSON.stringify(next));
            next.active = [];
            next.snoozed = [];
            Shell.state = {
                sidebar: next
            };
            tryCompare(list, "count", 0);
        }
    }
}
