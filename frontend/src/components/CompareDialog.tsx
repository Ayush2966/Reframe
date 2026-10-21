import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { X } from 'lucide-react'
import { api } from '../api'
import { useCamera } from '../camera-context'
import { buildSpec, timecode } from '../lib/format'
import { useEditor } from '../store'

type Frame = { url: string; size: string }

const ENHANCE_LABEL = {
  off: 'No enhancer',
  fast: 'Clean up and sharpen',
  ai: 'AI upscale',
  cloud: 'AI upscale (cloud)',
}

/** Renders the current frame exactly as the export will, with and without the
 * chosen enhancer, side by side under a draggable split. */
export function CompareDialog({ onClose }: { onClose: () => void }) {
  const { path } = useCamera()
  const [state] = useState(() => useEditor.getState())
  const active = state.shapes.find((s) => s.id === state.activeId) ?? state.shapes[0]
  const enhance = state.exp.enhance
  const comparing = enhance === 'fast' || enhance === 'ai'
  const [before, setBefore] = useState<Frame | null>(null)
  const [after, setAfter] = useState<Frame | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [split, setSplit] = useState(50)
  const [zoom, setZoom] = useState<'fit' | 'full'>('fit')
  const pair = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    const urls: string[] = []
    const spec = buildSpec(state, path ?? { rate: 1, x: [], y: [] }, active.id)
    const plain = { ...spec, enhance: 'off' as const }
    const keep = (set: (f: Frame) => void) => (f: Frame) => {
      urls.push(f.url)
      if (live) set(f)
    }
    api
      .frame(state.project!.id, plain, state.time)
      .then(keep(setBefore))
      .catch((e) => live && setError(e.message))
    if (comparing)
      api
        .frame(state.project!.id, spec, state.time)
        .then(keep(setAfter))
        .catch((e) => live && setError(e.message))
    return () => {
      live = false
      urls.forEach(URL.revokeObjectURL)
    }
  }, [state, path, active.id, comparing])

  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [onClose])

  const onSplit = (e: RPointerEvent) => {
    if (e.buttons !== 1 || !pair.current) return
    const r = pair.current.getBoundingClientRect()
    setSplit(Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100)))
  }

  const loading = !before || (comparing && !after)
  const label = ENHANCE_LABEL[enhance]

  return (
    <>
      <div className="scrim" style={{ zIndex: 30 }} onClick={onClose} />
      <div className="dialog" role="dialog" aria-label="Check a frame">
        <header>
          <h2>
            {active.rw}:{active.rh} at <span className="num">{timecode(state.time)}</span>
          </h2>
          <div className="seg" role="group" aria-label="Zoom">
            <button aria-pressed={zoom === 'fit'} onClick={() => setZoom('fit')}>
              Fit
            </button>
            <button aria-pressed={zoom === 'full'} onClick={() => setZoom('full')}>
              Actual pixels
            </button>
          </div>
          <button className="btn quiet icon" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>
        <div className={`compare${zoom === 'fit' ? ' fit' : ''}`}>
          {error ? (
            <p className="error-line" role="alert" style={{ padding: 24 }}>
              {error}
            </p>
          ) : loading ? (
            <p className="muted" role="status" style={{ padding: 24 }}>
              Rendering the frame{enhance === 'ai' ? '. The AI upscaler takes a few seconds' : ''}.
            </p>
          ) : (
            <div
              className="pair"
              ref={pair}
              style={{ ['--split' as string]: `${comparing ? split : 0}%` }}
              onPointerDown={(e) => {
                ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
                onSplit(e)
              }}
              onPointerMove={onSplit}
            >
              <img src={before!.url} alt="Without enhancement" draggable={false} />
              {comparing && after && (
                <>
                  <div className="after">
                    <img src={after.url} alt={`With ${label}`} draggable={false} />
                  </div>
                  <div className="divider" />
                  <span className="badge" style={{ left: 10 }}>
                    {ENHANCE_LABEL.off}
                  </span>
                  <span className="badge" style={{ right: 10 }}>
                    {label}
                  </span>
                </>
              )}
            </div>
          )}
        </div>
        <footer>
          <span className="num">{before?.size.replace('x', ' × ')}</span>
          <span>
            {comparing
              ? 'Drag across the picture to compare. Actual pixels shows the file 1:1.'
              : enhance === 'cloud'
                ? 'Cloud enhance runs on the whole clip, so this shows the frame before it.'
                : 'This is the exported frame with your look applied, sharpening included.'}
          </span>
        </footer>
      </div>
    </>
  )
}
