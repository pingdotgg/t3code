import QtQuick
import QtQuick.Shapes
import "js/lucide.js" as Lucide

// A lucide icon drawn as a stroke, so it scales and tints like the page's
// SVG icons. `name` is the lucide id ("panel-left"); see js/lucide.js.
Item {
    id: icon

    property string name: ""
    property real size: 16
    property color color: "#e4e4e7"
    property real strokeWidth: 2

    implicitWidth: size
    implicitHeight: size
    Accessible.ignored: true

    Shape {
        width: 24
        height: 24
        preferredRendererType: Shape.CurveRenderer
        transform: Scale {
            xScale: icon.size / 24
            yScale: icon.size / 24
        }

        ShapePath {
            strokeColor: icon.color
            strokeWidth: icon.strokeWidth
            fillColor: "transparent"
            capStyle: ShapePath.RoundCap
            joinStyle: ShapePath.RoundJoin

            PathSvg {
                path: Lucide.path(icon.name)
            }
        }
    }
}
