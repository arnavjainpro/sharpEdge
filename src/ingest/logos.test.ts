import { test, expect } from "bun:test";
import { PNG } from "pngjs";
import { trimBorder } from "./logos";

// Build a PNG with a solid background and an optional filled rectangle of ink,
// mirroring the shape of the real artwork: a mark sitting in a field of padding.
function png(w: number, h: number, bg: [number, number, number, number], ink?: { x: number; y: number; w: number; h: number }) {
  const p = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) << 2;
      const inside = ink && x >= ink.x && x < ink.x + ink.w && y >= ink.y && y < ink.y + ink.h;
      const c = inside ? [17, 17, 17, 255] : bg;
      p.data[i] = c[0]!; p.data[i + 1] = c[1]!; p.data[i + 2] = c[2]!; p.data[i + 3] = c[3]!;
    }
  }
  return PNG.sync.write(p);
}

const size = (buf: Buffer) => {
  const p = PNG.sync.read(buf);
  return [p.width, p.height];
};

const WHITE: [number, number, number, number] = [255, 255, 255, 255];

test("a mark adrift in padding is trimmed to the mark", () => {
  // The Apple case: ink covers well under half the canvas.
  const out = trimBorder(png(100, 100, WHITE, { x: 30, y: 23, w: 39, h: 48 }));
  expect(out).not.toBeNull();
  expect(size(out!)).toEqual([39, 48]);
});

test("padding is reclaimed only on the sides that have it", () => {
  // The NVIDIA case: full-bleed horizontally, letterboxed vertically. The left
  // and right edges must survive — trimming them would crop the artwork.
  const out = trimBorder(png(250, 250, WHITE, { x: 0, y: 41, w: 250, h: 166 }));
  expect(size(out!)).toEqual([250, 166]);
});

test("an edge-to-edge logo is returned untouched", () => {
  // The Microsoft case: nothing to reclaim. Returning null means the caller
  // serves the original bytes rather than a needlessly re-encoded copy.
  expect(trimBorder(png(250, 250, WHITE, { x: 0, y: 0, w: 250, h: 250 }))).toBeNull();
});

test("transparent padding counts as padding", () => {
  const out = trimBorder(png(64, 64, [0, 0, 0, 0], { x: 16, y: 16, w: 32, h: 32 }));
  expect(size(out!)).toEqual([32, 32]);
});

test("a blank image is left alone rather than trimmed to nothing", () => {
  expect(trimBorder(png(48, 48, WHITE))).toBeNull();
});

test("undecodable input is passed through, never thrown on", () => {
  // A logo must degrade to "serve what we got", not take down the request.
  expect(trimBorder(Buffer.from("this is not a png"))).toBeNull();
});

test("anti-aliased edges against the background are not mistaken for ink", () => {
  // A near-white halo around the mark should trim away with the padding;
  // otherwise every soft-edged logo keeps a ring of dead space.
  const p = PNG.sync.read(png(40, 40, WHITE, { x: 15, y: 15, w: 10, h: 10 }));
  for (let x = 10; x < 30; x++) {
    const i = (10 * 40 + x) << 2;
    p.data[i] = 250; p.data[i + 1] = 250; p.data[i + 2] = 250; p.data[i + 3] = 255;
  }
  const out = trimBorder(PNG.sync.write(p));
  expect(size(out!)).toEqual([10, 10]);
});
