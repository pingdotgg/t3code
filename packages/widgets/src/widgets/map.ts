import "maplibre-gl/dist/maplibre-gl.css";
import * as maplibre from "maplibre-gl";

import { card, cssVar, h, onThemeChange, start, t } from "../runtime.ts";

type Point = ReadonlyArray<number>;
interface Shape {
  readonly label?: string;
  readonly points: ReadonlyArray<Point>;
}
interface PlaceMap {
  readonly title: string;
  readonly pins?: ReadonlyArray<{
    readonly lat: number;
    readonly lon: number;
    readonly label: string;
    readonly description?: string;
  }>;
  readonly routes?: ReadonlyArray<Shape>;
  readonly areas?: ReadonlyArray<Shape>;
}

/** Models give latitude first; maps take longitude first. */
const toLngLat = (point: Point): [number, number] => [point[1] ?? 0, point[0] ?? 0];

const styleUrl = () =>
  `https://tiles.openfreemap.org/styles/${document.documentElement.dataset.theme === "dark" ? "dark" : "bright"}`;

const popupOf = (label: string, description?: string) =>
  new maplibre.Popup({ offset: 18 }).setDOMContent(
    h("div", {}, h("b", {}, label), description === undefined ? null : h("div", {}, description)),
  );

void start<PlaceMap>((data, root) => {
  const pins = data.pins ?? [];
  const routes = (data.routes ?? []).map(({ label, points }) => ({
    label,
    line: points.map(toLngLat),
  }));
  const areas = (data.areas ?? []).map(({ label, points }) => ({
    label,
    ring: [...points, ...points.slice(0, 1)].map(toLngLat),
  }));
  const canvas = h("div", { class: "map" });
  const places = h(
    "div",
    { class: "stack soft", style: "margin-top:10px" },
    ...pins.map(({ label, description }, at) =>
      h(
        "div",
        {},
        h("b", {}, `${at + 1}. ${label}`),
        description === undefined ? "" : ` · ${description}`,
      ),
    ),
  );
  root.append(
    card(data.title, [canvas, places], {
      ask: `${t("About the map", "O mapie")} "${data.title}": `,
    }),
  );

  const map = new maplibre.Map({
    container: canvas,
    style: styleUrl(),
    center: [19, 52],
    zoom: 4,
    cooperativeGestures: true,
    locale: {
      "CooperativeGesturesHandler.WindowsHelpText": t(
        "Use Ctrl + scroll to zoom the map",
        "Ctrl + przewijanie przybliża mapę",
      ),
      "CooperativeGesturesHandler.MacHelpText": t(
        "Use ⌘ + scroll to zoom the map",
        "⌘ + przewijanie przybliża mapę",
      ),
      "CooperativeGesturesHandler.MobileHelpText": t(
        "Use two fingers to move the map",
        "Przesuwaj mapę dwoma palcami",
      ),
    },
  });
  map.addControl(new maplibre.NavigationControl({ showCompass: false }), "top-left");

  const bounds = new maplibre.LngLatBounds();
  for (const point of [
    ...pins.map(({ lat, lon }): [number, number] => [lon, lat]),
    ...routes.flatMap(({ line }) => line),
    ...areas.flatMap(({ ring }) => ring),
  ]) {
    bounds.extend(point);
  }
  if (!bounds.isEmpty()) {
    // The attribution covers the bottom edge of a phone.
    const padding = { top: 48, right: 48, bottom: 84, left: 48 };
    map.fitBounds(bounds, { padding, maxZoom: 15, animate: false });
  }

  pins.forEach(({ lat, lon, label, description }, at) => {
    const element = h("div", {
      title: label,
      style: `display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:${cssVar("--accent")};color:${cssVar("--on-accent")};font:600 13px system-ui;border:2px solid #fff;cursor:pointer`,
    });
    element.textContent = String(at + 1);
    new maplibre.Marker({ element })
      .setLngLat([lon, lat])
      .setPopup(popupOf(label, description))
      .addTo(map);
  });

  // A new style drops its layers, so they are drawn again after a theme change.
  map.on("style.load", () => {
    const accent = cssVar("--accent");
    map.addSource("areas", {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: areas.map(({ label, ring }) => ({
          type: "Feature",
          properties: { label },
          geometry: { type: "Polygon", coordinates: [ring] },
        })),
      },
    });
    map.addSource("routes", {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: routes.map(({ label, line }) => ({
          type: "Feature",
          properties: { label },
          geometry: { type: "LineString", coordinates: line },
        })),
      },
    });
    map.addLayer({
      id: "areas",
      type: "fill",
      source: "areas",
      paint: { "fill-color": accent, "fill-opacity": 0.15 },
    });
    map.addLayer({
      id: "area-lines",
      type: "line",
      source: "areas",
      paint: { "line-color": accent, "line-width": 2 },
    });
    map.addLayer({
      id: "routes",
      type: "line",
      source: "routes",
      paint: { "line-color": accent, "line-width": 4 },
    });
  });
  map.on("click", ["areas", "routes"], ({ lngLat, features }) => {
    const label: unknown = features?.[0]?.properties.label;
    if (typeof label === "string") popupOf(label).setLngLat(lngLat).addTo(map);
  });

  let shownStyle = styleUrl();
  onThemeChange(() => {
    const next = styleUrl();
    if (next === shownStyle) return;
    shownStyle = next;
    map.setStyle(next);
  });
});
