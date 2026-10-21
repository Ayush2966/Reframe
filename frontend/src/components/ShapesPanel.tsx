import { useState, type FormEvent } from 'react'
import { X } from 'lucide-react'
import { SHAPE_PRESETS, shapeColor, useEditor } from '../store'
import type { Mode } from '../types'

const MODES: { id: Mode; label: string; title: string }[] = [
  { id: 'follow', label: 'Follow', title: 'Move the frame with the subject' },
  { id: 'center', label: 'Center', title: 'Keep the frame fixed in the middle' },
  { id: 'fit', label: 'Fit all', title: 'Show the whole picture with a blurred fill around it' },
]

function ShapeIcon({ rw, rh }: { rw: number; rh: number }) {
  const k = 20 / Math.max(rw, rh)
  return <i className="shape-icon" style={{ width: rw * k, height: rh * k }} />
}

export function ShapesPanel() {
  const shapes = useEditor((s) => s.shapes)
  const activeId = useEditor((s) => s.activeId)
  const src = useEditor((s) => s.project!.source!)
  const [custom, setCustom] = useState({ w: '', h: '' })
  const store = useEditor.getState()

  const addCustom = (e: FormEvent) => {
    e.preventDefault()
    const w = parseInt(custom.w, 10)
    const h = parseInt(custom.h, 10)
    if (w > 0 && h > 0 && w <= 100 && h <= 100) {
      const g = gcd(w, h)
      store.toggleShape(w / g, h / g)
      setCustom({ w: '', h: '' })
    }
  }

  return (
    <section className="section">
      <h2>Shapes</h2>
      <div className="chips" role="group" aria-label="Output shapes">
        {SHAPE_PRESETS.map((p) => {
          const on = shapes.some((s) => s.rw === p.rw && s.rh === p.rh)
          return (
            <button
              key={`${p.rw}:${p.rh}`}
              className="chip"
              aria-pressed={on}
              title={p.hint}
              style={{ ['--c' as string]: p.color }}
              onClick={() => store.toggleShape(p.rw, p.rh)}
            >
              <ShapeIcon rw={p.rw} rh={p.rh} />
              <span>
                {p.rw}:{p.rh}
              </span>
            </button>
          )
        })}
      </div>

      <div className="shape-rows">
        {shapes.map((s) => {
          const preset = SHAPE_PRESETS.find((p) => p.rw === s.rw && p.rh === s.rh)
          const sameAsSource = Math.abs(src.width / src.height - s.rw / s.rh) < 0.01
          return (
            <div
              key={s.id}
              className={`shape-row${s.id === activeId ? ' active' : ''}`}
              style={{ ['--c' as string]: shapeColor(s) }}
              onClick={() => store.setActive(s.id)}
            >
              <span className="swatch" />
              <span className="label">
                {s.rw}:{s.rh}
                <small>{sameAsSource ? 'same shape as the video' : (preset?.hint ?? 'Custom')}</small>
              </span>
              <button
                className="btn quiet icon small"
                aria-label={`Remove ${s.rw}:${s.rh}`}
                disabled={shapes.length === 1}
                onClick={(e) => {
                  e.stopPropagation()
                  store.removeShape(s.id)
                }}
              >
                <X size={14} />
              </button>
              <div
                className="seg"
                role="group"
                aria-label={`Framing for ${s.rw}:${s.rh}`}
                onClick={(e) => e.stopPropagation()}
              >
                {MODES.map((m) => (
                  <button
                    key={m.id}
                    aria-pressed={s.mode === m.id}
                    title={m.title}
                    onClick={() => store.setMode(s.id, m.id)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
          )
        })}
      </div>

      <form className="custom-row" onSubmit={addCustom}>
        <span className="muted" style={{ fontSize: 13, marginRight: 4 }}>
          Custom
        </span>
        <input
          className="text-input"
          inputMode="numeric"
          aria-label="Custom width"
          placeholder="W"
          value={custom.w}
          onChange={(e) => setCustom({ ...custom, w: e.target.value.replace(/\D/g, '') })}
        />
        <span className="muted">:</span>
        <input
          className="text-input"
          inputMode="numeric"
          aria-label="Custom height"
          placeholder="H"
          value={custom.h}
          onChange={(e) => setCustom({ ...custom, h: e.target.value.replace(/\D/g, '') })}
        />
        <button className="btn small" type="submit" disabled={!custom.w || !custom.h}>
          Add
        </button>
      </form>
    </section>
  )
}

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a
}
