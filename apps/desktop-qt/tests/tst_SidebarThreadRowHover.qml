import QtQuick
import QtTest
import T3.Shell
import "../qml/T3/Bricks"

Item {
    id: root
    width: 400
    height: 200

    Component {
        id: rowComponent
        SidebarThreadRow {
            width: 272
            height: 78
            active: false
            item: ({
                    title: qsTr("Review"),
                    status: "ready",
                    canSettle: true,
                    canSnooze: true,
                    branch: "main",
                    updatedAt: "2026-09-07T12:00:00Z"
                })
        }
    }

    TestCase {
        id: testCase
        name: "SidebarThreadRowHoverTests"
        when: windowShown
        property var observedBackground: null
        property real darkest: 1

        Connections {
            target: testCase.observedBackground
            function onColorChanged() {
                const c = testCase.observedBackground.color;
                testCase.darkest = Math.min(testCase.darkest, c.r * c.a + (1 - c.a) * 0.98);
            }
        }

        function cleanup() {
            observedBackground = null;
            Theme.colors = {};
        }

        function test_lightHoverNeverFlashesGray() {
            Theme.colors = {
                sidebarRowHover: "#fff7f4"
            };
            let row = createTemporaryObject(rowComponent, root);
            verify(!!row, "Component exists");
            let background = findChild(row, "rowBackground");
            verify(!!background, "Object exists");
            observedBackground = background;
            darkest = 0.98;
            mouseMove(row, 100, 40);
            tryCompare(background, "color", "#fff7f4");
            verify(darkest >= 0.98);
            mouseMove(root, 380, 150);
            tryCompare(background, "color", Qt.alpha("#fff7f4", 0));
            verify(darkest >= 0.98);
        }

        function test_hoverAcrossActions() {
            let row = createTemporaryObject(rowComponent, root);
            verify(!!row, "Component exists");
            mouseMove(row, 10, 12);
            tryCompare(row, "showActions", true);
            for (let x = 180; x < 264; ++x) {
                mouseMove(row, x, 15, 20);
                tryCompare(row, "showActions", true, 100);
            }
            mouseMove(root, 380, 150);
            tryCompare(row, "showActions", false);
        }
    }
}
