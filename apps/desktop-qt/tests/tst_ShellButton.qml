import QtQuick
import QtTest
import T3.Shell
import "../qml/T3/Bricks"

Item {
    id: root
    width: 400
    height: 200

    Component {
        id: buttonComponent
        ShellButton {
            width: 120
            height: 32
            tint: "#ff0000"
            iconTint: tint
            background: Rectangle {
                color: "#000000"
            }
        }
    }

    TestCase {
        id: testCase
        name: "ShellButtonTests"
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

        Component {
            id: themedButtonComponent
            ShellButton {
                width: 100
                height: 32
                subtle: true
                text: qsTr("Settings")
            }
        }

        function cleanup() {
            observedBackground = null;
            Theme.colors = {};
        }

        function test_lightHoverNeverFlashesGray() {
            Theme.colors = {
                accentSurface: "#fff7f4"
            };
            let button = createTemporaryObject(themedButtonComponent, root);
            verify(!!button, "Component exists");
            observedBackground = button.background;
            darkest = 0.98;
            mouseMove(button, 50, 16);
            tryCompare(button.background, "color", "#fff7f4");
            verify(darkest >= 0.98);
            mouseMove(root, 380, 150);
            tryCompare(button.background, "color", Qt.alpha("#fff7f4", 0));
            verify(darkest >= 0.98);
        }

        function test_narrowContentsStayInsidePadding() {
            let button = createTemporaryObject(buttonComponent, root, {
                text: qsTr("A long action label"),
                iconName: "plus",
                chevron: true,
                width: 90
            });
            verify(!!button, "Component exists");
            let contents = findChild(button, "contents");
            verify(!!contents, "Object exists");
            tryCompare(contents, "width", button.availableWidth);
            compare(contents.x, 0);
            button.width = 240;
            tryVerify(() => contents.width < button.availableWidth);
            compare(Math.round(contents.x + contents.width / 2), Math.round(button.availableWidth / 2));
        }

        function test_centeredContents_data() {
            return [
                {
                    tag: "label",
                    text: qsTr("Update"),
                    iconName: "",
                    chevron: false,
                    width: 120,
                    height: 32
                },
                {
                    tag: "dismiss",
                    text: "✕",
                    iconName: "",
                    chevron: false,
                    width: 26,
                    height: 26
                },
                {
                    tag: "icon",
                    text: "",
                    iconName: "x",
                    chevron: false,
                    width: 40,
                    height: 28
                },
                {
                    tag: "icon-label",
                    text: qsTr("Update"),
                    iconName: "plus",
                    chevron: false,
                    width: 160,
                    height: 32
                },
                {
                    tag: "chevron",
                    text: "",
                    iconName: "",
                    chevron: true,
                    width: 40,
                    height: 24
                }
            ];
        }

        function test_centeredContents(data) {
            let button = createTemporaryObject(buttonComponent, root, {
                text: data.text,
                iconName: data.iconName,
                chevron: data.chevron,
                width: data.width,
                height: data.height,
                leftPadding: data.tag === "dismiss" ? 0 : 8,
                rightPadding: data.tag === "dismiss" ? 0 : 8
            });
            verify(!!button, "Component exists");
            verify(waitForRendering(button));
            let shot = grabImage(button);
            let left = shot.width;
            let right = -1;
            let top = shot.height;
            let bottom = -1;
            for (let y = 0; y < shot.height; ++y) {
                for (let x = 0; x < shot.width; ++x) {
                    if (shot.red(x, y) > 80 && shot.green(x, y) < 40) {
                        left = Math.min(left, x);
                        right = Math.max(right, x);
                        top = Math.min(top, y);
                        bottom = Math.max(bottom, y);
                    }
                }
            }
            verify(right >= left);
            verify(Math.abs((left + right + 1) / 2 - button.width / 2) <= 2);
            verify(Math.abs((top + bottom + 1) / 2 - button.height / 2) <= 2);
        }
    }
}
