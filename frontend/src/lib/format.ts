import type { PathData, RenderSpec } from '../types'
import { lookMatrix } from './look'
import type { useEditor } from '../store'

type State = ReturnType<typeof useEditor.getState>

export function timecode(t: number, withFraction = true) {
  if (!Number.isFinite(t)) t = 0
  const m = Math.floor(t / 60)
  const s = t - m * 60
  return withFraction ? `${m}:${s.toFixed(2).padStart(5, '0')}` : `${m}:${Math.floor(s).toString().padStart(2, '0')}`
}

export function bytes(n: number) {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(n < 100 * 1024 * 1024 ? 1 : 0)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

export function duration(seconds: number) {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`
  const m = Math.round(seconds / 60)
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)} h ${m % 60} min`
}

export function dims(w: number, h: number) {
  return `${w} × ${h}`
}

export function buildSpec(s: State, path: PathData, onlyShapeId?: string): RenderSpec {
  const shapes = onlyShapeId ? s.shapes.filter((x) => x.id === onlyShapeId) : s.shapes
  return {
    projectId: s.project!.id,
    path,
    outputs: shapes.map((x) => ({ id: x.id, rw: x.rw, rh: x.rh, mode: x.mode })),
    look: { matrix: lookMatrix(s.look), vignette: s.look.vignette, sharpen: s.look.sharpen },
    size: s.exp.size,
    enhance: s.exp.enhance,
    quality: s.exp.quality,
    trim: s.trim ?? undefined,
  }
}
