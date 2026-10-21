import { useMemo, type ReactNode } from 'react'
import { CameraContext } from './camera-context'
import { applyManual, densePath, smoothTrack } from './lib/path'
import { trackSubject } from './lib/track'
import { useEditor } from './store'

/** Computes the camera path once for the whole editor. */
export function CameraProvider({ children }: { children: ReactNode }) {
  const analysis = useEditor((s) => s.analysis)
  const seeds = useEditor((s) => s.seeds)
  const target = useEditor((s) => s.target)
  const smoothness = useEditor((s) => s.smoothness)
  const manual = useEditor((s) => s.manual)
  const src = useEditor((s) => s.project?.source)
  const aspect = src ? src.width / src.height : 16 / 9
  const rate = src ? Math.min(60, src.fps) : 30

  const raw = useMemo(
    () => (analysis ? trackSubject(analysis, seeds, target, aspect) : null),
    [analysis, seeds, target, aspect],
  )
  const auto = useMemo(
    () => (raw && analysis ? smoothTrack(raw, analysis, smoothness) : null),
    [raw, analysis, smoothness],
  )
  const samples = useMemo(
    () => (auto && analysis ? applyManual(auto, manual, analysis) : null),
    [auto, manual, analysis],
  )
  const path = useMemo(
    () => (samples && analysis ? densePath(samples, analysis, rate) : null),
    [samples, analysis, rate],
  )
  const coverage = raw ? raw.found.filter(Boolean).length / Math.max(1, raw.found.length) : 0

  const value = useMemo(() => ({ raw, samples, path, coverage }), [raw, samples, path, coverage])
  return <CameraContext.Provider value={value}>{children}</CameraContext.Provider>
}
