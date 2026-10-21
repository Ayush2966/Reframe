// A look is a set of slider values that compiles to one 3x4 colour matrix
// (rows r, g, b: coefficients for r, g, b, then an offset in 0..1). The editor
// previews it with an SVG feColorMatrix and ffmpeg applies the same numbers
// with colorchannelmixer, so the preview and the export match.
import type { LookSettings } from '../types'

export type Matrix = number[] // length 12

export const IDENTITY: Matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]

/** B ∘ A: apply A first, then B. */
export function compose(B: Matrix, A: Matrix): Matrix {
  const out = new Array(12).fill(0)
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 4 + c] = B[r * 4] * A[c] + B[r * 4 + 1] * A[4 + c] + B[r * 4 + 2] * A[8 + c]
    }
    out[r * 4 + 3] = B[r * 4] * A[3] + B[r * 4 + 1] * A[7] + B[r * 4 + 2] * A[11] + B[r * 4 + 3]
  }
  return out
}

const diag = (r: number, g: number, b: number, off = 0): Matrix => [r, 0, 0, off, 0, g, 0, off, 0, 0, b, off]

/** The CSS/SVG saturate() matrix. */
function saturate(s: number): Matrix {
  // prettier-ignore
  return [
    0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0,
    0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0,
    0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s, 0,
  ]
}

export const DEFAULT_LOOK: LookSettings = {
  preset: 'original',
  brightness: 0,
  contrast: 0,
  saturation: 0,
  warmth: 0,
  tint: 0,
  fade: 0,
  vignette: 0,
  sharpen: 0,
}

export function lookMatrix(l: LookSettings): Matrix {
  const steps: Matrix[] = [
    diag(1 + 0.4 * l.brightness, 1 + 0.4 * l.brightness, 1 + 0.4 * l.brightness),
    (() => {
      const c = 1 + 0.5 * l.contrast
      return diag(c, c, c, 0.5 * (1 - c))
    })(),
    saturate(1 + l.saturation),
    diag(1 + 0.1 * l.warmth, 1 + 0.015 * l.warmth, 1 - 0.1 * l.warmth),
    diag(1 + 0.03 * l.tint, 1 - 0.08 * l.tint, 1 + 0.03 * l.tint),
    diag(1 - 0.22 * l.fade, 1 - 0.22 * l.fade, 1 - 0.22 * l.fade, 0.09 * l.fade),
  ]
  return steps.reduce((acc, m) => compose(m, acc), IDENTITY).map((v) => Math.round(v * 1e5) / 1e5)
}

export function isIdentity(m: Matrix) {
  return m.every((v, i) => Math.abs(v - IDENTITY[i]) < 1e-4)
}

/** values="" for <feColorMatrix type="matrix">. */
export function svgMatrixValues(m: Matrix) {
  // prettier-ignore
  return [
    m[0], m[1], m[2], 0, m[3],
    m[4], m[5], m[6], 0, m[7],
    m[8], m[9], m[10], 0, m[11],
    0, 0, 0, 1, 0,
  ].join(' ')
}

/**
 * ffmpeg's vignette darkens by cos(angle·d)^4, d being the distance from the
 * centre over the half-diagonal. A black radial gradient with alpha
 * 1 - cos^4 reproduces it on top of the preview.
 */
export function vignetteGradient(amount: number) {
  if (amount <= 0.001) return 'none'
  const angle = 0.2 + 0.6 * amount
  const stops = []
  for (let i = 0; i <= 10; i++) {
    const d = i / 10
    const alpha = 1 - Math.pow(Math.cos(angle * d), 4)
    stops.push(`rgba(0,0,0,${alpha.toFixed(3)}) ${d * 100}%`)
  }
  return `radial-gradient(circle farthest-corner at 50% 50%, ${stops.join(', ')})`
}

export interface Preset {
  id: string
  name: string
  values: Partial<LookSettings>
}

export const PRESETS: Preset[] = [
  { id: 'original', name: 'Original', values: {} },
  { id: 'vivid', name: 'Vivid', values: { contrast: 0.2, saturation: 0.35, brightness: 0.03 } },
  { id: 'warm', name: 'Golden', values: { warmth: 0.55, saturation: 0.1, contrast: 0.05 } },
  { id: 'cool', name: 'Cool', values: { warmth: -0.5, tint: 0.08, contrast: 0.05 } },
  { id: 'film', name: 'Film', values: { fade: 0.45, warmth: 0.25, saturation: -0.2, contrast: 0.1 } },
  { id: 'moody', name: 'Moody', values: { contrast: 0.3, saturation: -0.3, brightness: -0.08, vignette: 0.45 } },
  { id: 'bright', name: 'Airy', values: { brightness: 0.12, contrast: -0.1, fade: 0.15, saturation: -0.05 } },
  { id: 'mono', name: 'Mono', values: { saturation: -1, contrast: 0.25 } },
]

export function presetLook(id: string, keep?: LookSettings): LookSettings {
  const p = PRESETS.find((x) => x.id === id) ?? PRESETS[0]
  return { ...DEFAULT_LOOK, vignette: keep?.vignette ?? 0, sharpen: keep?.sharpen ?? 0, ...p.values, preset: p.id }
}
