// Company logos, proxied rather than hotlinked.
//
// FMP serves these from a public image CDN with no key. Pointing <img> tags
// straight at it would work, but every render would tell a third party which
// symbols this user holds and watches — a portfolio leak by side channel, from
// the user's own IP. So the browser asks this app, and this app asks FMP.
//
// The cache is the other half: misses are remembered too. Futures, delisted
// names and anything else without artwork 404 permanently, and without negative
// caching every re-render would re-request them forever.

import { PNG } from "pngjs";
import { SYMBOL_RE } from "./universe";

const CDN = "https://images.financialmodelingprep.com/symbol";

// FMP writes class shares with a dot (BRK.B) and serves a higher-resolution
// asset under it — the dash form resolves but to a smaller image. Same edge
// conversion as ingest/fmp.ts.
const toFmp = (t: string) => t.replace(/-/g, ".");

const HIT_TTL_MS = 7 * 86400_000;
const MISS_TTL_MS = 86400_000;
const MAX_ENTRIES = 600;

interface Entry {
  bytes: ArrayBuffer | null;   // null = known-missing
  type: string;
  ts: number;
}

const cache = new Map<string, Entry>();

const fresh = (e: Entry) => Date.now() - e.ts < (e.bytes ? HIT_TTL_MS : MISS_TTL_MS);

// Crude cap, same shape as the quote cache in ingest/finnhub.ts: logos are a few
// KB each, and an unbounded map behind a 12k-symbol search box is a slow leak.
function remember(ticker: string, entry: Entry) {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(ticker, entry);
}

export interface Logo {
  bytes: ArrayBuffer;
  type: string;
}

// How different a channel must be from the border colour to count as artwork.
// Loose enough to ignore JPEG-ish ringing and anti-aliased edges on a flat field.
const INK_TOLERANCE = 24;

// These logos are not drawn to a common margin: Apple is a small mark adrift in
// white (its ink covers 39% x 48% of the canvas), NVIDIA is letterboxed to 66%
// height, Microsoft runs edge to edge. Rendered into one fixed box they come out
// at visibly different sizes, and no amount of object-fit can help — the padding
// is in the pixels, not the layout.
//
// So trim the uniform border away and let each mark fill its box, which is what
// the edge-to-edge ones already do. Logos whose border is NOT one flat colour
// (Microsoft's four coloured squares) are left exactly as they are: there is no
// margin to reclaim, and guessing would eat the artwork.
export function trimBorder(input: Buffer): Buffer | null {
  let png: PNG;
  try {
    png = PNG.sync.read(input);
  } catch {
    return null; // not a PNG we can read — serve the original untouched
  }
  const { width: w, height: h, data } = png;
  if (w < 4 || h < 4) return null;

  const at = (x: number, y: number) => (y * w + x) << 2;
  const bg = [data[0]!, data[1]!, data[2]!, data[3]!] as const;

  const isBg = (x: number, y: number) => {
    const i = at(x, y);
    // Fully transparent counts as background whatever the colour channels say.
    if (data[i + 3]! < 16 && bg[3] < 16) return true;
    return (
      Math.abs(data[i]! - bg[0]) <= INK_TOLERANCE &&
      Math.abs(data[i + 1]! - bg[1]) <= INK_TOLERANCE &&
      Math.abs(data[i + 2]! - bg[2]) <= INK_TOLERANCE &&
      Math.abs(data[i + 3]! - bg[3]) <= INK_TOLERANCE
    );
  };
  // Only whole rows/columns of flat background come off. A mark that reaches an
  // edge simply keeps that edge — NVIDIA loses its top and bottom bands and
  // nothing else — and a frame with no flat edge at all (Microsoft's top row is
  // half orange, half green) is left completely untouched.
  let top = 0, bottom = h - 1, left = 0, right = w - 1;
  const rowIsBg = (y: number) => { for (let x = 0; x < w; x++) if (!isBg(x, y)) return false; return true; };
  const colIsBg = (x: number) => { for (let y = 0; y < h; y++) if (!isBg(x, y)) return false; return true; };
  while (top < bottom && rowIsBg(top)) top++;
  while (bottom > top && rowIsBg(bottom)) bottom--;
  while (left < right && colIsBg(left)) left++;
  while (right > left && colIsBg(right)) right--;

  const cw = right - left + 1;
  const ch = bottom - top + 1;
  // Nothing to reclaim, or the image is blank — leave it alone either way.
  if (cw < 2 || ch < 2 || (cw === w && ch === h)) return null;

  const out = new PNG({ width: cw, height: ch });
  for (let y = 0; y < ch; y++) {
    data.copy(out.data, (y * cw) << 2, at(left, top + y), at(left, top + y) + (cw << 2));
  }
  return PNG.sync.write(out);
}

// Null means "no logo for this symbol" — the caller should 404, not retry.
export async function fetchLogo(rawTicker: string): Promise<Logo | null> {
  const ticker = String(rawTicker ?? "").trim().toUpperCase();
  // Reject before spending a request. This also quietly covers futures ("ES=F"),
  // option composites and crypto, none of which have artwork — and it keeps
  // arbitrary path input from reaching the CDN.
  if (!SYMBOL_RE.test(ticker)) return null;

  const hit = cache.get(ticker);
  if (hit && fresh(hit)) return hit.bytes ? { bytes: hit.bytes, type: hit.type } : null;

  try {
    const res = await fetch(`${CDN}/${encodeURIComponent(toFmp(ticker))}.png`, {
      signal: AbortSignal.timeout(10_000),
    });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !type.startsWith("image/")) {
      // A 404 here is a fact about the symbol, not a blip — remember it.
      remember(ticker, { bytes: null, type: "", ts: Date.now() });
      return null;
    }
    const raw = await res.arrayBuffer();
    // Trim once, on the way into the cache, so this never runs per request.
    const trimmed = trimBorder(Buffer.from(raw));
    const bytes = trimmed ? trimmed.buffer.slice(trimmed.byteOffset, trimmed.byteOffset + trimmed.byteLength) as ArrayBuffer : raw;
    remember(ticker, { bytes, type: trimmed ? "image/png" : type, ts: Date.now() });
    return { bytes, type: trimmed ? "image/png" : type };
  } catch {
    // Network trouble is transient, so it is deliberately NOT cached as a miss.
    return null;
  }
}
