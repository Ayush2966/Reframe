// Mirrors backend/internal/app/render.go so the frame drawn in the editor is
// exactly the one that gets rendered. Keep the two in step.
import type { Mode, SizeOption } from '../types'

export const evenRound = (v: number) => Math.max(2, Math.round(v / 2) * 2)
export const evenCeil = (v: number) => {
  const n = Math.ceil(v)
  return n + (n % 2)
}
const evenFloor = (v: number) => v & ~1

/** Largest rw:rh rectangle inside the source. */
export function cropWindow(W: number, H: number, rw: number, rh: number): [number, number] {
  const a = rw / rh
  if (W / H >= a) {
    const h = evenFloor(H)
    let w = evenRound(h * a)
    if (w > W) w = evenFloor(W)
    return [w, h]
  }
  const w = evenFloor(W)
  let h = evenRound(w / a)
  if (h > H) h = evenFloor(H)
  return [w, h]
}

/** Smallest rw:rh canvas holding the whole source without resampling it. */
export function fitCanvas(W: number, H: number, rw: number, rh: number): [number, number] {
  const a = rw / rh
  if (W / H >= a) {
    const w = evenCeil(W)
    return [w, evenCeil(w / a)]
  }
  const h = evenCeil(H)
  return [evenCeil(h * a), h]
}

const SHORT_SIDE: Record<string, number> = { '1080': 1080, '1440': 1440, '2160': 2160 }

export function outputDims(
  nativeW: number,
  nativeH: number,
  rw: number,
  rh: number,
  size: SizeOption,
): [number, number] {
  const s = SHORT_SIDE[size]
  if (!s) return [nativeW, nativeH]
  const a = rw / rh
  return a >= 1 ? [evenRound(s * a), s] : [s, evenRound(s / a)]
}

export function nativeDims(W: number, H: number, rw: number, rh: number, mode: Mode): [number, number] {
  return mode === 'fit' ? fitCanvas(W, H, rw, rh) : cropWindow(W, H, rw, rh)
}

/** Window top-left in source pixels for a centre point, like Plan.cropAt. */
export function windowAt(W: number, H: number, w: number, h: number, cx: number, cy: number): [number, number] {
  const clampI = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)
  const x = clampI(Math.round(cx * W - w / 2), 0, W - w) & ~1
  const y = clampI(Math.round(cy * H - h / 2), 0, H - h) & ~1
  return [x, y]
}

export function ratioLabel(rw: number, rh: number) {
  return `${rw}:${rh}`
}
