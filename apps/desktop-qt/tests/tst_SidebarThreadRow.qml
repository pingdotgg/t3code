import QtQuick
import QtTest
import "../qml/T3/Bricks"

Item {
    id: root
    width: 400
    height: 180

    Component {
        id: rowComponent

        SidebarThreadRow {
            width: 360
            height: 78
            active: false
            item: ({
                title: "Review",
                status: "ready",
                unread: false,
                wokeAt: null,
                wakeLabel: null,
                canSettle: true,
                canSnooze: true,
                branch: "main",
                updatedAt: new Date(Date.now() - 59500).toISOString()
            })
        }
    }

    TestCase {
        name: "SidebarThreadRowTests"
        when: windowShown

        function test_relativeAgeRefreshesWhileIdle() {
            let row = createTemporaryObject(rowComponent, root);
            verify(!!row, "Component exists");
            let timer = findChild(row, "ageRefreshTimer");
            verify(!!timer, "Object exists");
            compare(row.ageLabel, qsTr("now"));

            timer.interval = 25;
            timer.restart();

            tryCompare(row, "ageLabel", qsTr("1m"), 2000);
        }
    }
}
