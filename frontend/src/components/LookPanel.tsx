import { useEffect, useRef } from 'react'
import { Eye } from 'lucide-react'
import { lookMatrix, presetLook, PRESETS, svgMatrixValues } from '../lib/look'
import { useEditor, videoRef } from '../store'
import type { LookSettings } from '../types'

/** SVG filters the previews use: the current look and each preset. */
export function LookDefs() {
  const look = useEditor((s) => s.look)
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <filter id="look-current" colorInterpolationFilters="sRGB" x="0" y="0" width="100%" height="100%">
        <feColorMatrix type="matrix" values={svgMatrixValues(lookMatrix(look))} />
      </filter>
      {PRESETS.map((p) => (
        <filter key={p.id} id={`look-${p.id}`} colorInterpolationFilters="sRGB" x="0" y="0" width="100%" height="100%">
          <feColorMatrix type="matrix" values={svgMatrixValues(lookMatrix(presetLook(p.id)))} />
        </filter>
      ))}
    </svg>
  )
}

const SLIDERS: { key: keyof LookSettings; label: string; min: number; max: number }[] = [
  { key: 'brightness', label: 'Brightness', min: -1, max: 1 },
  { key: 'contrast', label: 'Contrast', min: -1, max: 1 },
  { key: 'saturation', label: 'Saturation', min: -1, max: 1 },
  { key: 'warmth', label: 'Warmth', min: -1, max: 1 },
  { key: 'tint', label: 'Tint', min: -1, max: 1 },
  { key: 'fade', label: 'Fade', min: 0, max: 1 },
  { key: 'vignette', label: 'Vignette', min: 0, max: 1 },
  { key: 'sharpen', label: 'Sharpen', min: 0, max: 1 },
]

export function LookPanel() {
  const look = useEditor((s) => s.look)
  const time = useEditor((s) => s.time)
  const playing = useEditor((s) => s.playing)
  const store = useEditor.getState()
  const thumbs = useRef(new Map<string, HTMLCanvasElement>())

  // Preset swatches show the current frame; refresh when paused on a new moment.
  useEffect(() => {
    if (playing) return
    const v = videoRef.current
    const draw = () => {
      if (!v || v.readyState < 2) return
      for (const c of thumbs.current.values()) {
        const ctx = c.getContext('2d')
        if (!ctx) continue
        const k = Math.max(c.width / v.videoWidth, c.height / v.videoHeight)
        ctx.drawImage(
          v,
          (c.width - v.videoWidth * k) / 2,
          (c.height - v.videoHeight * k) / 2,
          v.videoWidth * k,
          v.videoHeight * k,
        )
      }
    }
    draw()
    v?.addEventListener('loadeddata', draw)
    return () => v?.removeEventListener('loadeddata', draw)
  }, [time, playing])

  const touched = SLIDERS.some((s) => look[s.key] !== 0) || look.preset !== 'original'

  return (
    <section className="section">
      <h2>
        Look
        <span style={{ display: 'flex', gap: 4 }}>
          <button
            className="btn quiet small"
            onPointerDown={() => store.setBypassLook(true)}
            onPointerUp={() => store.setBypassLook(false)}
            onPointerLeave={() => store.setBypassLook(false)}
            onKeyDown={(e) => e.key === ' ' && store.setBypassLook(true)}
            onKeyUp={() => store.setBypassLook(false)}
            disabled={!touched}
            title="Hold to see the original"
          >
            <Eye size={14} /> Hold for original
          </button>
        </span>
      </h2>
      <div className="presets" role="group" aria-label="Looks">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            className="preset"
            aria-pressed={look.preset === p.id}
            onClick={() => store.applyPreset(p.id)}
          >
            <canvas
              ref={(el) => {
                if (el) thumbs.current.set(p.id, el)
                else thumbs.current.delete(p.id)
              }}
              width={128}
              height={96}
              style={{ filter: `url(#look-${p.id})` }}
            />
            {p.name}
          </button>
        ))}
      </div>
      <div className="sliders">
        {SLIDERS.map((s) => {
          const v = look[s.key] as number
          return (
            <div className="slider" key={s.key}>
              <label htmlFor={`look-${s.key}`}>{s.label}</label>
              <output className="num" htmlFor={`look-${s.key}`}>
                {v > 0 && s.min < 0 ? '+' : ''}
                {Math.round(v * 100)}
              </output>
              <input
                id={`look-${s.key}`}
                type="range"
                min={s.min}
                max={s.max}
                step={0.01}
                value={v}
                style={{ ['--fill' as string]: `${((v - s.min) / (s.max - s.min)) * 100}%` }}
                onChange={(e) => store.setLook({ [s.key]: parseFloat(e.target.value), preset: 'custom' })}
                onDoubleClick={() => store.setLook({ [s.key]: 0 })}
                title="Double-click to reset"
              />
            </div>
          )
        })}
      </div>
      {look.sharpen > 0 && (
        <p className="hint">Sharpening shows in the export and in Check a frame, not in these previews.</p>
      )}
      {touched && (
        <button
          className="link"
          style={{ justifySelf: 'start', fontSize: 12.5 }}
          onClick={() => store.applyPreset('original')}
        >
          Reset look
        </button>
      )}
    </section>
  )
}
