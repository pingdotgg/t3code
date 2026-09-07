import QtQuick
import QtTest
import T3.Shell
import "../qml/T3/Bricks"

Item {
    id: root
    width: 400
    height: 300

    Component {
        id: notificationsComponent
        Notifications {
            width: 340
            height: implicitHeight
        }
    }

    TestCase {
        name: "NotificationsTests"
        when: windowShown

        function cleanup() {
            Shell.reset();
            Theme.colors = {};
            Theme.radius = 8;
        }

        function test_accentClearsRoundedCorners_data() {
            return [
                {
                    tag: "square",
                    radius: 0
                },
                {
                    tag: "terminal",
                    radius: 4
                },
                {
                    tag: "glass-minimal",
                    radius: 10
                },
                {
                    tag: "dashboard",
                    radius: 18
                }
            ];
        }

        function isAccent(shot, x, y) {
            return shot.red(x, y) > 200 && shot.green(x, y) < 60 && shot.blue(x, y) < 60;
        }

        function test_accentClearsRoundedCorners(data) {
            Theme.radius = data.radius;
            Theme.colors = {
                warning: "#ff0000",
                surfaceOverlay: "#ffffff",
                border: "#ffffff"
            };
            Shell.state = {
                notifications: {
                    items: [
                        {
                            id: "update",
                            type: "warning",
                            title: qsTr("Update available"),
                            description: qsTr("Install the update now or review provider settings."),
                            actions: []
                        }
                    ]
                }
            };
            let toast = createTemporaryObject(notificationsComponent, root);
            verify(!!toast, "Component exists");
            tryVerify(() => {
                const shot = grabImage(toast);
                return isAccent(shot, 2, Math.floor(shot.height / 2));
            });
            const shot = grabImage(toast);
            let top = shot.height;
            let bottom = -1;
            for (let y = 0; y < shot.height; ++y) {
                for (let x = 0; x < 6; ++x) {
                    if (isAccent(shot, x, y)) {
                        top = Math.min(top, y);
                        bottom = Math.max(bottom, y);
                    }
                }
            }
            verify(bottom > top);
            verify(top >= Math.max(1, data.radius));
            verify(bottom < shot.height - Math.max(1, data.radius));
            compare(Math.abs(top - (shot.height - 1 - bottom)) <= 1, true);
        }
    }
}
