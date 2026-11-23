import "leaflet/dist/leaflet.css";
import * as L from "leaflet";

import { card, cssVar, h, onThemeChange, start, t } from "../runtime.ts";

type Point = ReadonlyArray<number>;
interface PlaceMap {
  readonly title: string;
  readonly pins?: ReadonlyArray<{
    readonly lat: number;
    readonly lon: number;
    readonly label: string;
    readonly description?: string;
  }>;
  readonly routes?: ReadonlyArray<{
    readonly label?: string;
    readonly points: ReadonlyArray<Point>;
  }>;
  readonly areas?: ReadonlyArray<{
    readonly label?: string;
    readonly points: ReadonlyArray<Point>;
  }>;
}

const toLatLng = (point: Point) => L.latLng(point[0] ?? 0, point[1] ?? 0);

void start<PlaceMap>((data, root) => {
  const canvas = h("div", { class: "map" });
  const places = h(
    "div",
    { class: "stack soft", style: "margin-top:10px" },
    ...(data.pins ?? []).map(({ label, description }, at) =>
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

  const map = L.map(canvas, { scrollWheelZoom: false, attributionControl: true });
  let tiles: L.TileLayer | undefined;
  const drawTiles = () => {
    const style = document.documentElement.dataset.theme === "dark" ? "dark_all" : "voyager";
    tiles?.remove();
    tiles = L.tileLayer(
      `https://{s}.basemaps.cartocdn.com/${style === "voyager" ? "rastertiles/voyager" : style}/{z}/{x}/{y}{r}.png`,
      {
        maxZoom: 19,
        subdomains: "abcd",
        attribution: "© OpenStreetMap contributors © CARTO",
      },
    ).addTo(map);
  };
  drawTiles();

  const accent = cssVar("--accent") || "#3552d1";
  const layers: Array<L.Layer> = [
    ...(data.pins ?? []).map(({ lat, lon, label, description }, at) =>
      L.marker([lat, lon], {
        title: label,
        icon: L.divIcon({
          className: "",
          iconSize: [28, 28],
          iconAnchor: [14, 14],
          html: `<span style="display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:${accent};color:#fff;font:600 13px system-ui;border:2px solid #fff">${at + 1}</span>`,
        }),
      }).bindPopup(
        h(
          "div",
          {},
          h("b", {}, label),
          description === undefined ? null : h("div", {}, description),
        ),
      ),
    ),
    ...(data.routes ?? []).map(({ points, label }) => {
      const route = L.polyline(points.map(toLatLng), { color: accent, weight: 4 });
      return label === undefined ? route : route.bindPopup(h("b", {}, label));
    }),
    ...(data.areas ?? []).map(({ points, label }) => {
      const area = L.polygon(points.map(toLatLng), { color: accent, fillOpacity: 0.15 });
      return label === undefined ? area : area.bindPopup(h("b", {}, label));
    }),
  ];
  const bounds = L.featureGroup(layers).addTo(map).getBounds();
  if (bounds.isValid()) map.fitBounds(bounds.pad(0.2), { maxZoom: 15, animate: false });
  else map.setView([52, 19], 5);
  new ResizeObserver(() => map.invalidateSize()).observe(canvas);
  onThemeChange(drawTiles);
});
