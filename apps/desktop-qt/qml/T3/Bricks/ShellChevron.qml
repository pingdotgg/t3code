import QtQuick
import QtQuick.Shapes

// A small down chevron drawn as a stroke, so it sits on the control's centre
// line instead of on a glyph baseline.
Shape {
    id: chevron

    property color color: "#8b8b93"
    property real strokeWidth: 1.5

    width: 9
    height: 6
    preferredRendererType: Shape.CurveRenderer

    ShapePath {
        strokeColor: chevron.color
        strokeWidth: chevron.strokeWidth
        fillColor: "transparent"
        capStyle: ShapePath.RoundCap
        joinStyle: ShapePath.RoundJoin
        startX: 0.5
        startY: 0.5

        PathLine {
            x: chevron.width / 2
            y: chevron.height - 0.5
        }

        PathLine {
            x: chevron.width - 0.5
            y: 0.5
        }
    }
}
