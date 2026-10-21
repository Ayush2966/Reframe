import { create } from 'zustand'
import { DEFAULT_LOOK, presetLook } from './lib/look'
import { emptyManual, steer } from './lib/path'
import type {
  Analysis,
  EnhanceOption,
  LookSettings,
  Manual,
  Mode,
  Project,
  QualityOption,
  SavedState,
  Seed,
  Shape,
  SizeOption,
} from './types'

export interface ShapePreset {
  rw: number
  rh: number
  hint: string
  color: string
}

// Frame-guide colours, like a camera monitor: each shape keeps its colour on
// the frame lines, its preview and its render progress.
export const SHAPE_PRESETS: ShapePreset[] = [
  { rw: 9, rh: 16, hint: 'Reels, Shorts, TikTok', color: '#F5C542' },
  { rw: 4, rh: 5, hint: 'Instagram feed', color: '#4FD1D9' },
  { rw: 1, rh: 1, hint: 'Square', color: '#F07AB8' },
  { rw: 4, rh: 3, hint: 'Classic', color: '#8FD16A' },
  { rw: 3, rh: 4, hint: 'Portrait', color: '#F2994A' },
  { rw: 2, rh: 3, hint: 'Pinterest', color: '#A98BF5' },
  { rw: 16, rh: 9, hint: 'YouTube, TV', color: '#E8E8E4' },
  { rw: 21, rh: 9, hint: 'Cinema', color: '#6FA8FF' },
]
const CUSTOM_COLORS = ['#FF8F8F', '#7FE0B5', '#E0C27F', '#9FB4FF']

/** A shape's colour depends only on the shape, so it matches everywhere. */
export function shapeColor(s: { rw: number; rh: number }) {
  return (
    SHAPE_PRESETS.find((p) => p.rw === s.rw && p.rh === s.rh)?.color ??
    CUSTOM_COLORS[(s.rw * 7 + s.rh * 3) % CUSTOM_COLORS.length]
  )
}

const shapeId = (rw: number, rh: number) => `${rw}x${rh}`

function defaultShapes(project: Project): Shape[] {
  const src = project.source
  const wide = !src || src.width >= src.height
  return wide ? [{ id: '9x16', rw: 9, rh: 16, mode: 'follow' }] : [{ id: '16x9', rw: 16, rh: 9, mode: 'fit' }]
}

export type ExportSettings = { size: SizeOption; enhance: EnhanceOption; quality: QualityOption }

interface EditorState {
  project: Project | null
  analysis: Analysis | null
  analyzing: number | null
  analysisError: string | null

  time: number
  playing: boolean
  showPeople: boolean
  exportOpen: boolean
  /** Held "compare" button: show the picture without the look. */
  bypassLook: boolean

  shapes: Shape[]
  activeId: string
  target: 'one' | 'group'
  smoothness: number
  seeds: Seed[]
  manual: Manual | null
  look: LookSettings
  exp: ExportSettings
  trim: { start: number; end: number } | null

  load(project: Project, saved: SavedState | null, analysis: Analysis | null): void
  setProject(project: Project): void
  setAnalysis(a: Analysis | null): void
  setAnalyzing(p: number | null, error?: string | null): void
  setTime(t: number): void
  setPlaying(p: boolean): void
  setShowPeople(v: boolean): void
  setExportOpen(v: boolean): void
  setBypassLook(v: boolean): void

  toggleShape(rw: number, rh: number): void
  setMode(id: string, mode: Mode): void
  setActive(id: string): void
  removeShape(id: string): void

  setTarget(t: 'one' | 'group'): void
  setSmoothness(v: number): void
  addSeed(s: Seed): void
  clearSeeds(): void
  steer(t: number, cx: number, cy: number, recording: boolean): void
  endSteer(): void
  resetSteering(): void

  setLook(patch: Partial<LookSettings>): void
  applyPreset(id: string): void
  setExp(patch: Partial<ExportSettings>): void
  setTrim(trim: { start: number; end: number } | null): void
  saved(): SavedState
}

let lastSteerIndex: number | null = null

export const useEditor = create<EditorState>((set, get) => ({
  project: null,
  analysis: null,
  analyzing: null,
  analysisError: null,
  time: 0,
  playing: false,
  showPeople: true,
  exportOpen: false,
  bypassLook: false,
  shapes: [],
  activeId: '',
  target: 'one',
  smoothness: 0.5,
  seeds: [],
  manual: null,
  look: DEFAULT_LOOK,
  exp: { size: '1080', enhance: 'off', quality: 'high' },
  trim: null,

  load(project, saved, analysis) {
    const shapes = saved?.shapes?.length ? saved.shapes : defaultShapes(project)
    const manualOk = saved?.manual && analysis && saved.manual.w.length === analysis.samples.length
    set({
      project,
      analysis,
      analyzing: null,
      analysisError: null,
      time: 0,
      playing: false,
      exportOpen: false,
      shapes,
      activeId: shapes.some((s) => s.id === saved?.activeId) ? saved!.activeId : shapes[0].id,
      target: saved?.target ?? 'one',
      smoothness: saved?.smoothness ?? 0.5,
      seeds: saved?.seeds ?? [],
      manual: manualOk ? saved!.manual : null,
      look: { ...DEFAULT_LOOK, ...saved?.look },
      exp: saved?.exp ?? { size: '1080', enhance: 'off', quality: 'high' },
      trim: saved?.trim ?? null,
    })
  },
  setProject: (project) => set({ project }),
  setAnalysis: (analysis) => set({ analysis, analyzing: null, manual: null }),
  setAnalyzing: (analyzing, error = null) => set({ analyzing, analysisError: error }),
  setTime: (time) => set({ time }),
  setPlaying: (playing) => set({ playing }),
  setShowPeople: (showPeople) => set({ showPeople }),
  setExportOpen: (exportOpen) => set({ exportOpen }),
  setBypassLook: (bypassLook) => set({ bypassLook }),

  toggleShape(rw, rh) {
    const { shapes, activeId } = get()
    const id = shapeId(rw, rh)
    if (shapes.some((s) => s.id === id)) {
      if (shapes.length === 1) return
      const rest = shapes.filter((s) => s.id !== id)
      set({ shapes: rest, activeId: activeId === id ? rest[0].id : activeId })
      return
    }
    const src = get().project?.source
    const sameShape = src && Math.abs(src.width / src.height - rw / rh) < 0.01
    set({ shapes: [...shapes, { id, rw, rh, mode: sameShape ? 'center' : 'follow' }], activeId: id })
  },
  setMode: (id, mode) => set({ shapes: get().shapes.map((s) => (s.id === id ? { ...s, mode } : s)) }),
  setActive: (activeId) => set({ activeId }),
  removeShape(id) {
    const { shapes, activeId } = get()
    if (shapes.length === 1) return
    const rest = shapes.filter((s) => s.id !== id)
    set({ shapes: rest, activeId: activeId === id ? rest[0].id : activeId })
  },

  setTarget: (target) => set({ target }),
  setSmoothness: (smoothness) => set({ smoothness }),
  addSeed: (s) => set({ seeds: [...get().seeds.filter((x) => Math.abs(x.t - s.t) > 0.05), s], target: 'one' }),
  clearSeeds: () => set({ seeds: [] }),
  steer(t, cx, cy, recording) {
    const { analysis, manual } = get()
    if (!analysis) return
    const base = manual ?? emptyManual(analysis.samples.length)
    const res = steer(base, analysis, t, cx, cy, recording, lastSteerIndex)
    lastSteerIndex = res.index
    set({ manual: res.manual })
  },
  endSteer: () => {
    lastSteerIndex = null
  },
  resetSteering: () => set({ manual: null }),

  setLook: (patch) => set({ look: { ...get().look, ...patch } }),
  applyPreset: (id) => set({ look: presetLook(id, get().look) }),
  setExp: (patch) => set({ exp: { ...get().exp, ...patch } }),
  setTrim: (trim) => set({ trim }),

  saved() {
    const s = get()
    return {
      shapes: s.shapes,
      activeId: s.activeId,
      target: s.target,
      smoothness: s.smoothness,
      seeds: s.seeds,
      manual: s.manual,
      look: s.look,
      exp: s.exp,
      trim: s.trim,
    }
  },
}))

/** The playing <video>: previews draw from it every frame. */
export const videoRef: { current: HTMLVideoElement | null } = { current: null }

// Handy for poking at the editor from the console during development.
if (import.meta.env.DEV) (window as unknown as { __reframe: typeof useEditor }).__reframe = useEditor
