/**
 * Quad words share f32/u32 storage: 0-5 world a,b,c,d,tx,ty; 6-9 local x,y,w,h; 10-13 radii.
 * 14-20 world clip center x,y, half w,h, cos,sin,radius; 21-24 kind params.
 * 25-28 UV u0,v0,u1,v1 (25: family id with FLAG_TABLE); 29 premultiplied rgba8; 30 flags.
 * 31 is outer effect opacity, bypassed while drawing its compositing layer.
 */
export const STRIDE = 32;
export const W_CLIP = 14;
export const W_PARAMS = 21;
export const W_UV = 25;
export const W_COLOR = 29;
export const W_FLAGS = 30;
export const W_EFFECT_ALPHA = 31;
/** Floats per clip: cx cy hx hy cos sin radius. */
export const CLIP_SIZE = 7;
export const STRIDE_BYTES = STRIDE * 4;

export const KIND_FILL = 0;
export const KIND_STROKE = 1;
export const KIND_SHADOW = 2;
export const KIND_INSET = 3;
export const KIND_TEXT = 4;
export const KIND_TEXTURE = 5;

export const FLAG_ELLIPSE = 1 << 4;
export const PAINT_SHIFT = 5;
export const PAINT_LINEAR = 1;
export const PAINT_RADIAL = 2;
export const PAINT_IMAGE = 3;
export const FLAG_TILE = 1 << 7;
export const LAYER_SHIFT = 8;
export const FLAG_SCREEN = 1 << 17;
/** uv comes from the family table row `word 23`. */
export const FLAG_TABLE = 1 << 18;

export const NO_CLIP = 1e9;
