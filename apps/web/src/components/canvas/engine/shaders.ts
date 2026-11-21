/**
 * Every primitive (fills, strokes, analytic shadows, text and textures) is
 * an instanced quad. Software GPUs also compile this shader with a fixed
 * PRIMITIVE_KIND to remove unused fragment paths. Colors are premultiplied.
 */

import { FLAG_SCREEN, FLAG_TABLE } from "./format";
import { TABLE_WIDTH } from "./textures";

export const VERTEX_SHADER = /* glsl */ `#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in vec4 aM;
layout(location = 1) in vec2 aT;
layout(location = 2) in vec4 aRect;
layout(location = 3) in vec4 aRadii;
layout(location = 4) in vec4 aClip;
layout(location = 5) in vec3 aClipRot;
layout(location = 6) in vec4 aParams;
layout(location = 7) in vec4 aUV;
layout(location = 8) in vec4 aColor;
layout(location = 9) in uint aFlags;
layout(location = 10) in float aEffectAlpha;

// Layer contents defer their outer opacity until compositing.
uniform bool uCompositeLayer;

// x: device px per world unit, zw: device translation.
uniform vec4 uView;
uniform vec2 uViewport;
// Visible world rect, used to cull quads before rasterization.
uniform vec4 uWorldView;
uniform float uFlipY;
// Family table: per family [u0 v0 u1 v1][layer resident 0 0].
uniform highp sampler2D uTable;

out vec2 vLocal;
out vec2 vWorld;
flat out vec4 vRect;
flat out vec4 vRadii;
flat out vec4 vClip;
flat out vec3 vClipRot;
flat out vec4 vParams;
flat out vec4 vUV;
flat out vec4 vColor;
flat out float vEffectAlpha;
flat out uint vFlags;
// Local units per device px.
flat out float vPx;
// x: atlas layer, y: 1 when the texture is resident.
flat out vec2 vMisc;

void cull() {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}

void main() {
  if (aColor.a <= 0.0 || (!uCompositeLayer && aEffectAlpha <= 0.0)) {
    cull(); return;
  }
  uint kind = aFlags & 15u;
  bool screen = (aFlags & ${FLAG_SCREEN}u) != 0u;
  float scale = sqrt(abs(aM.x * aM.w - aM.y * aM.z));
  float pxPerLocal = uView.x * max(scale, 1e-6);
  float px = 1.0 / pxPerLocal;
  float expand = px;
  if (kind == 1u) {
    expand += max(screen ? aParams.y * px : aParams.y, 0.0);
  } else if (kind == 2u) {
    expand += 3.0 * aParams.x;
  }
  vec4 rect = aRect;
  vec2 lo = rect.xy - expand;
  vec2 hi = rect.xy + rect.zw + expand;
  mat2 m = mat2(aM.x, aM.y, aM.z, aM.w);
  vec2 p0 = m * lo + aT;
  vec2 p1 = m * vec2(hi.x, lo.y) + aT;
  vec2 p2 = m * vec2(lo.x, hi.y) + aT;
  vec2 p3 = m * hi + aT;
  vec2 mn = max(min(min(p0, p1), min(p2, p3)), uWorldView.xy);
  vec2 mx = min(max(max(p0, p1), max(p2, p3)), uWorldView.zw);
  if (aClip.z < 1e8) {
    vec2 c = abs(aClipRot.xy);
    vec2 extent = vec2(c.x * aClip.z + c.y * aClip.w, c.y * aClip.z + c.x * aClip.w);
    mn = max(mn, aClip.xy - extent);
    mx = min(mx, aClip.xy + extent);
  }
  if (mn.x > mx.x || mn.y > mx.y) { cull(); return; }

  // Offscreen quads need no family-table reads (two per vertex).
  vec4 uv = aUV;
  float layer = float((aFlags >> 8u) & 255u);
  bool resident = true;
  if ((aFlags & ${FLAG_TABLE}u) != 0u) {
    int texel = int(aUV.x + 0.5) * 2;
    ivec2 at = ivec2(texel % ${TABLE_WIDTH}, texel / ${TABLE_WIDTH});
    uv = texelFetch(uTable, at, 0);
    vec4 meta = texelFetch(uTable, ivec2(at.x + 1, at.y), 0);
    layer = meta.x;
    resident = meta.y > 0.5;
  } else if (kind >= 4u) {
    resident = false;
  }
  if ((kind == 4u || kind == 5u) && !resident) { cull(); return; }

  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vec2 local = mix(lo, hi, corner);
  vec2 world = m * local + aT;
  vec2 device = world * uView.x + uView.zw;
  gl_Position = vec4(
    device.x / uViewport.x * 2.0 - 1.0,
    (1.0 - device.y / uViewport.y * 2.0) * uFlipY,
    0.0,
    1.0
  );
  vLocal = local;
  vWorld = world;
  vRect = aRect;
  vRadii = aRadii;
  vClip = aClip;
  vClipRot = aClipRot;
  vParams = aParams;
  vUV = uv;
  vMisc = vec2(layer, resident ? 1.0 : 0.0);
  vColor = aColor;
  vEffectAlpha = uCompositeLayer ? 1.0 : aEffectAlpha;
  vFlags = aFlags;
  vPx = px;
}
`;

export const FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;

uniform sampler2DArray uAtlas;
uniform vec4 uView;

in vec2 vLocal;
in vec2 vWorld;
flat in vec4 vRect;
flat in vec4 vRadii;
flat in vec4 vClip;
flat in vec3 vClipRot;
flat in vec4 vParams;
flat in vec4 vUV;
flat in vec4 vColor;
flat in float vEffectAlpha;
flat in uint vFlags;
flat in float vPx;
flat in vec2 vMisc;

out vec4 outColor;

float sdRoundRect(vec2 p, vec2 b, vec4 r) {
  float rad = p.x < 0.0 ? (p.y < 0.0 ? r.x : r.w) : (p.y < 0.0 ? r.y : r.z);
  vec2 q = abs(p) - b + rad;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - rad;
}

float sdEllipse(vec2 p, vec2 ab) {
  ab = max(ab, vec2(1e-4));
  float k0 = length(p / ab);
  float k1 = length(p / (ab * ab));
  return k1 > 1e-6 ? k0 * (k0 - 1.0) / k1 : -min(ab.x, ab.y);
}

float sdShape(vec2 local, vec4 rect, vec4 radii, bool ellipse) {
  vec2 h = rect.zw * 0.5;
  vec2 p = local - rect.xy - h;
  return ellipse ? sdEllipse(p, h) : sdRoundRect(p, h, radii);
}

float cover(float sd, float px) {
  return clamp(0.5 - sd / px, 0.0, 1.0);
}

// Arc length along the outline, clockwise from the top edge's left end
// (ellipses: from the top, by eccentric angle over Ramanujan's perimeter).
float outlinePos(vec2 local, vec4 rect, vec4 r, bool ellipse) {
  vec2 h = rect.zw * 0.5;
  vec2 p = local - rect.xy - h;
  if (ellipse) {
    float a = max(h.x, 1e-4);
    float b = max(h.y, 1e-4);
    float phi = atan(p.x * b, -p.y * a);
    if (phi < 0.0) phi += 6.2831853;
    float perimeter = 3.14159265 * (3.0 * (a + b) - sqrt((3.0 * a + b) * (a + 3.0 * b)));
    return phi * 0.15915494 * perimeter;
  }
  const float Q = 1.5707963;
  float s0 = 2.0 * h.x - r.x - r.y;
  float s1 = s0 + Q * r.y;
  float s2 = s1 + 2.0 * h.y - r.y - r.z;
  float s3 = s2 + Q * r.z;
  float s4 = s3 + 2.0 * h.x - r.z - r.w;
  float s5 = s4 + Q * r.w;
  float s6 = s5 + 2.0 * h.y - r.w - r.x;
  vec2 d = p - vec2(h.x - r.y, r.y - h.y);
  if (r.y > 0.0 && d.x > 0.0 && d.y < 0.0) return s0 + r.y * atan(d.x, -d.y);
  d = p - vec2(h.x - r.z, h.y - r.z);
  if (r.z > 0.0 && d.x > 0.0 && d.y > 0.0) return s2 + r.z * atan(d.y, d.x);
  d = p - vec2(r.w - h.x, h.y - r.w);
  if (r.w > 0.0 && d.x < 0.0 && d.y > 0.0) return s4 + r.w * atan(-d.x, d.y);
  d = p - vec2(r.x - h.x, r.x - h.y);
  if (r.x > 0.0 && d.x < 0.0 && d.y < 0.0) return s6 + r.x * atan(-d.y, -d.x);
  float top = p.y + h.y;
  float right = h.x - p.x;
  float bottom = h.y - p.y;
  float left = p.x + h.x;
  float m = min(min(top, right), min(bottom, left));
  if (m == top) return p.x + h.x - r.x;
  if (m == right) return s1 + p.y + h.y - r.y;
  if (m == bottom) return s3 + h.x - r.z - p.x;
  return s5 + h.y - r.w - p.y;
}

// Coverage of an on/off dash pattern at outline position s.
float dashCover(float s, float on, float off, float px) {
  float period = on + off;
  if (period < px * 3.0) return on / period;
  float m = mod(s, period);
  float d = m < on ? min(m, on - m) : -min(m - on, period - m);
  return clamp(d / px + 0.5, 0.0, 1.0);
}

vec2 erf2(vec2 x) {
  vec2 s = sign(x);
  vec2 a = abs(x);
  x = 1.0 + (0.278393 + (0.230389 + 0.078108 * (a * a)) * a) * a;
  x *= x;
  return s - s / (x * x);
}

float gaussian(float x, float sigma) {
  return exp(-(x * x) / (2.0 * sigma * sigma)) / (2.5066282746 * sigma);
}

// Evan Wallace's closed-form gaussian blur of a rounded rect.
float shadowX(float x, float y, float sigma, float corner, vec2 halfSize) {
  float delta = min(halfSize.y - corner - abs(y), 0.0);
  float curved = halfSize.x - corner + sqrt(max(0.0, corner * corner - delta * delta));
  vec2 integral = 0.5 + 0.5 * erf2((x + vec2(-curved, curved)) * (0.70710678 / sigma));
  return integral.y - integral.x;
}

float boxShadow(vec2 p, vec2 halfSize, float sigma, float corner) {
  float low = p.y - halfSize.y;
  float high = p.y + halfSize.y;
  float start = clamp(-3.0 * sigma, low, high);
  float end = clamp(3.0 * sigma, low, high);
  float step = (end - start) / 4.0;
  float y = start + step * 0.5;
  float value = 0.0;
  for (int i = 0; i < 4; i++) {
    value += shadowX(p.x, p.y - y, sigma, corner, halfSize) * gaussian(y, sigma) * step;
    y += step;
  }
  return value;
}

float shadowAlpha(vec2 local, vec4 rect, vec4 radii, bool ellipse, float sigma, float px) {
  vec2 h = rect.zw * 0.5;
  vec2 p = local - rect.xy - h;
  if (sigma < px * 0.5) return cover(ellipse ? sdEllipse(p, h) : sdRoundRect(p, h, radii), px);
  if (ellipse) {
    float d = sdEllipse(p, h) * 0.70710678 / sigma;
    return 0.5 - 0.5 * erf2(vec2(d)).x;
  }
  float corner = p.x < 0.0 ? (p.y < 0.0 ? radii.x : radii.w) : (p.y < 0.0 ? radii.y : radii.z);
  return boxShadow(p, h, sigma, min(corner, min(h.x, h.y)));
}

vec4 sampleAtlas(vec2 t) {
  return texture(uAtlas, vec3(mix(vUV.xy, vUV.zw, t), vMisc.x));
}

vec4 paint(vec2 local) {
  uint p = (vFlags >> 5u) & 3u;
  if (p == 0u) return vColor;
  if (p == 3u) {
    // Image still decoding or rasterizing: a faint placeholder.
    if (vMisc.y < 0.5) return vColor * 0.13;
    vec2 t = (local - vParams.xy) / vParams.zw;
    if ((vFlags & 128u) != 0u) t = fract(t);
    else if (t.x < 0.0 || t.y < 0.0 || t.x > 1.0 || t.y > 1.0) return vec4(0.0);
    return sampleAtlas(t) * vColor;
  }
  float t;
  if (p == 1u) {
    vec2 d = vParams.zw - vParams.xy;
    t = dot(local - vParams.xy, d) / max(dot(d, d), 1e-6);
  } else {
    t = length((local - vParams.xy) / max(vParams.zw, vec2(1e-6)));
  }
  return sampleAtlas(vec2(clamp(t, 0.0, 1.0), 0.0)) * vColor;
}

void main() {
#ifdef PRIMITIVE_KIND
  uint kind = PRIMITIVE_KIND;
#else
  uint kind = vFlags & 15u;
#endif
#ifdef PRIMITIVE_ELLIPSE
  bool ellipse = PRIMITIVE_ELLIPSE;
#else
  bool ellipse = (vFlags & 16u) != 0u;
#endif
  float px = vPx;
  vec4 color = vColor;
  float alpha = 1.0;
  // Reject fully clipped pixels before sampling textures or integrating shadows.
  float clipAlpha = 1.0;
  if (vClip.z < 1e8) {
    vec2 d = vWorld - vClip.xy;
    vec2 p = vec2(vClipRot.x * d.x + vClipRot.y * d.y, vClipRot.x * d.y - vClipRot.y * d.x);
    clipAlpha = cover(sdRoundRect(p, vClip.zw, vec4(vClipRot.z)), 1.0 / uView.x);
    if (clipAlpha <= 0.0) discard;
  }
  if (kind == 0u) {
    alpha = cover(sdShape(vLocal, vRect, vRadii, ellipse), px);
    if (alpha <= 0.0) discard;
    color = paint(vLocal);
  } else if (kind == 1u) {
    float sd = sdShape(vLocal, vRect, vRadii, ellipse);
    vec2 band = (vFlags & ${FLAG_SCREEN}u) != 0u ? vParams.xy * px : vParams.xy;
    alpha = cover(sd - band.y, px) - cover(sd + band.x, px);
    if (alpha <= 0.0) discard;
    if (vParams.z > 0.0) {
      alpha *= dashCover(outlinePos(vLocal, vRect, vRadii, ellipse), vParams.z, vParams.w, px);
    }
  } else if (kind == 2u) {
    vec4 shape = vec4(vRect.xy - vParams.yz + vParams.w, vRect.zw - 2.0 * vParams.w);
    float mask = 1.0 - cover(sdShape(vLocal, shape, max(vRadii - vParams.w, 0.0), ellipse), px);
    if (mask <= 0.0) discard;
    alpha = shadowAlpha(vLocal, vRect, vRadii, ellipse, vParams.x, px) * mask;
  } else if (kind == 3u) {
    float mask = cover(sdShape(vLocal, vRect, vRadii, ellipse), px);
    if (mask <= 0.0) discard;
    vec4 hole = vec4(vRect.xy + vParams.yz + vParams.w, vRect.zw - 2.0 * vParams.w);
    float lit = hole.z <= 0.0 || hole.w <= 0.0
      ? 0.0
      : shadowAlpha(vLocal, hole, max(vRadii - vParams.w, 0.0), ellipse, vParams.x, px);
    alpha = mask * (1.0 - lit);
  } else {
    // The antialias margin must not sample neighbouring atlas entries.
    vec2 t = (vLocal - vRect.xy) / vRect.zw;
    if (t.x < 0.0 || t.y < 0.0 || t.x > 1.0 || t.y > 1.0) discard;
    color = sampleAtlas(t) * vColor;
  }
  alpha *= clipAlpha;
  if (alpha <= 0.0) discard;
  outColor = color * (alpha * vEffectAlpha);
}
`;
