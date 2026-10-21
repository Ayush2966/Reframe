// From raw subject positions to the camera path the renderer follows:
// fill gaps, ignore jitter, move like a steady operator, never pan across a cut.
import type { Analysis, Manual, PathData } from '../types'
import type { RawTrack } from './track'
import { shotAt, shotOfSamples } from './track'

export interface SamplePath {
  x: number[]
  y: number[]
}

function shotRanges(shots: number[]): [number, number][] {
  const out: [number, number][] = []
  let s = 0
  for (let i = 1; i <= shots.length; i++) {
    if (i === shots.length || shots[i] !== shots[s]) {
      out.push([s, i - 1])
      s = i
    }
  }
  return out
}

function fillGaps(v: number[], found: boolean[], lo: number, hi: number) {
  const known: number[] = []
  for (let i = lo; i <= hi; i++) if (found[i]) known.push(i)
  if (!known.length) {
    for (let i = lo; i <= hi; i++) v[i] = 0.5
    return
  }
  for (let i = lo; i < known[0]; i++) v[i] = v[known[0]]
  for (let i = known[known.length - 1] + 1; i <= hi; i++) v[i] = v[known[known.length - 1]]
  for (let k = 0; k + 1 < known.length; k++) {
    const a = known[k]
    const b = known[k + 1]
    for (let i = a + 1; i < b; i++) v[i] = v[a] + ((v[b] - v[a]) * (i - a)) / (b - a)
  }
}

function median5(v: number[], lo: number, hi: number) {
  const src = v.slice(lo, hi + 1)
  for (let i = lo; i <= hi; i++) {
    const w: number[] = []
    for (let j = i - 2; j <= i + 2; j++) w.push(src[Math.min(hi, Math.max(lo, j)) - lo])
    w.sort((a, b) => a - b)
    v[i] = w[2]
  }
}

/** Only move when the subject leaves a small zone; run both ways and average
 * so the camera neither lags nor leads. */
function deadzone(v: number[], lo: number, hi: number, dz: number) {
  if (dz <= 0) return
  const pass = (from: number, to: number, step: number) => {
    const out = new Array(v.length).fill(0)
    let c = v[from]
    for (let i = from; step > 0 ? i <= to : i >= to; i += step) {
      if (v[i] > c + dz) c = v[i] - dz
      else if (v[i] < c - dz) c = v[i] + dz
      out[i] = c
    }
    return out
  }
  const f = pass(lo, hi, 1)
  const b = pass(hi, lo, -1)
  for (let i = lo; i <= hi; i++) v[i] = (f[i] + b[i]) / 2
}

function gaussian(v: number[], lo: number, hi: number, sigma: number) {
  if (sigma < 0.3) return
  const r = Math.ceil(sigma * 3)
  const k: number[] = []
  for (let j = -r; j <= r; j++) k.push(Math.exp(-(j * j) / (2 * sigma * sigma)))
  const src = v.slice(lo, hi + 1)
  for (let i = lo; i <= hi; i++) {
    let s = 0
    let ws = 0
    for (let j = -r; j <= r; j++) {
      const idx = Math.min(hi, Math.max(lo, i + j)) - lo
      s += src[idx] * k[j + r]
      ws += k[j + r]
    }
    v[i] = s / ws
  }
}

/** smoothness 0..1: 0 reacts quickly, 1 is a slow, steady operator. */
export function smoothTrack(raw: RawTrack, a: Analysis, smoothness: number): SamplePath {
  const x = raw.x.slice()
  const y = raw.y.slice()
  const sigma = (0.2 + 1.1 * smoothness) * a.sampleFps
  const dz = 0.005 + 0.035 * smoothness
  for (const [lo, hi] of shotRanges(shotOfSamples(a))) {
    for (const v of [x, y]) {
      fillGaps(v, raw.found, lo, hi)
      median5(v, lo, hi)
      deadzone(v, lo, hi, dz)
      gaussian(v, lo, hi, sigma)
    }
  }
  return { x, y }
}

export function emptyManual(n: number): Manual {
  return { x: new Array(n).fill(0.5), y: new Array(n).fill(0.5), w: new Array(n).fill(0) }
}

export function hasManual(m: Manual | null) {
  return !!m && m.w.some((w) => w > 0.001)
}

/** Blend hand steering over the automatic path, then soften recorded jitter. */
export function applyManual(auto: SamplePath, manual: Manual | null, a: Analysis): SamplePath {
  if (!hasManual(manual) || manual!.w.length !== auto.x.length) return auto
  const m = manual!
  const x = auto.x.map((v, i) => v * (1 - m.w[i]) + m.x[i] * m.w[i])
  const y = auto.y.map((v, i) => v * (1 - m.w[i]) + m.y[i] * m.w[i])
  for (const [lo, hi] of shotRanges(shotOfSamples(a))) {
    gaussian(x, lo, hi, 0.12 * a.sampleFps)
    gaussian(y, lo, hi, 0.12 * a.sampleFps)
  }
  return { x, y }
}

/** Steer at time t. While playing it records exactly where you hold the frame;
 * when paused it bends the path smoothly around that moment. */
export function steer(
  manual: Manual,
  a: Analysis,
  t: number,
  cx: number,
  cy: number,
  recording: boolean,
  lastIndex: number | null,
): { manual: Manual; index: number } {
  const n = a.samples.length
  const i = Math.min(n - 1, Math.max(0, Math.round(t * a.sampleFps)))
  const m: Manual = { x: manual.x.slice(), y: manual.y.slice(), w: manual.w.slice() }
  const shots = shotOfSamples(a)
  if (recording) {
    const from = lastIndex !== null && lastIndex < i && i - lastIndex < a.sampleFps ? lastIndex + 1 : i
    for (let j = from; j <= i; j++) {
      m.x[j] = cx
      m.y[j] = cy
      m.w[j] = 1
    }
    return { manual: m, index: i }
  }
  const R = Math.max(2, Math.round(0.75 * a.sampleFps))
  for (let j = i - R; j <= i + R; j++) {
    if (j < 0 || j >= n || shots[j] !== shots[i]) continue
    const fall = 0.5 * (1 + Math.cos((Math.PI * (j - i)) / (R + 1)))
    m.x[j] = cx
    m.y[j] = cy
    m.w[j] = Math.max(m.w[j], fall)
  }
  return { manual: m, index: i }
}

/** Resample to `rate` per second (the video's frame rate) for the renderer.
 * Within a shot it uses a Catmull-Rom curve; at a cut it switches instantly. */
export function densePath(p: SamplePath, a: Analysis, rate: number): PathData {
  const n = p.x.length
  const shots = shotOfSamples(a)
  const count = Math.ceil(a.duration * rate) + 1
  const out: PathData = { rate, x: new Array(count), y: new Array(count) }
  const fps = a.sampleFps
  for (let k = 0; k < count; k++) {
    const t = k / rate
    const shot = shotAt(a.cuts, t)
    const f = t * fps
    let i = Math.min(n - 1, Math.max(0, Math.floor(f)))
    // Stay inside this moment's shot.
    while (i > 0 && shots[i] > shot) i--
    while (i < n - 1 && shots[i] < shot) i++
    const u = Math.min(1, Math.max(0, f - i))
    const same = (j: number) => j >= 0 && j < n && shots[j] === shots[i]
    const at = (v: number[], j: number) => v[same(j) ? j : i]
    for (const [src, dst] of [
      [p.x, out.x],
      [p.y, out.y],
    ] as const) {
      if (!same(i + 1) || shots[i] !== shot) {
        dst[k] = src[i]
        continue
      }
      const p0 = at(src, i - 1)
      const p1 = src[i]
      const p2 = src[i + 1]
      const p3 = same(i + 2) ? src[i + 2] : p2
      const v =
        0.5 *
        (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u)
      dst[k] = Math.min(1, Math.max(0, v))
    }
  }
  return out
}

/** Same lookup the renderer does (nearest sample). */
export function pathAt(p: PathData, t: number): [number, number] {
  if (!p.x.length) return [0.5, 0.5]
  const i = Math.min(p.x.length - 1, Math.max(0, Math.round(t * p.rate)))
  return [p.x[i], p.y[i]]
}
