import { useEffect, useRef } from 'react'
import { useCamera } from '../camera-context'
import { dims } from '../lib/format'
import { cropWindow, fitCanvas, outputDims, windowAt } from '../lib/geometry'
import { isIdentity, lookMatrix, vignetteGradient } from '../lib/look'
import { pathAt } from '../lib/path'
import { shapeColor, useEditor, videoRef } from '../store'
import type { PathData, Shape, SourceInfo } from '../types'

const TILE_H = 190

/** Live previews of every output shape, drawn from the playing video. */
export function OutputStrip() {
  const shapes = useEditor((s) => s.shapes)
  const activeId = useEditor((s) => s.activeId)
  const look = useEditor((s) => s.look)
  const bypass = useEditor((s) => s.bypassLook)
  const size = useEditor((s) => s.exp.size)
  const src = useEditor((s) => s.project!.source!)
  const { path } = useCamera()
  const canvases = useRef(new Map<string, HTMLCanvasElement>())
  const pathRef = useRef(path)
  const dirty = useRef(true)
  // Any re-render (new path, shapes, sizes) means the tiles need redrawing.
  useEffect(() => {
    pathRef.current = path
    dirty.current = true
  })

  // One loop draws every tile; it reads the latest state each frame.
  useEffect(() => {
    let id = 0
    let lastTime = -1
    const draw = () => {
      id = requestAnimationFrame(draw)
      const v = videoRef.current
      if (!v || v.readyState < 2) return
      if (v.paused && v.currentTime === lastTime && !dirty.current) return
      lastTime = v.currentTime
      dirty.current = false
      for (const s of useEditor.getState().shapes) {
        const c = canvases.current.get(s.id)
        if (c) drawTile(c, v, s, src, pathRef.current, v.currentTime)
      }
    }
    id = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(id)
  }, [src])

  const graded = !bypass && !isIdentity(lookMatrix(look))
  const vignette = bypass ? 'none' : vignetteGradient(look.vignette)

  return (
    <div className="outputs" aria-label="Output previews">
      {shapes.map((s) => {
        const [nw, nh] =
          s.mode === 'fit'
            ? fitCanvas(src.width, src.height, s.rw, s.rh)
            : cropWindow(src.width, src.height, s.rw, s.rh)
        const [ow, oh] = outputDims(nw, nh, s.rw, s.rh, size)
        const scale = ow / nw
        const w = Math.round((TILE_H * s.rw) / s.rh)
        return (
          <button
            key={s.id}
            className={`tile${s.id === activeId ? ' active' : ''}`}
            style={{ ['--c' as string]: shapeColor(s) }}
            onClick={() => useEditor.getState().setActive(s.id)}
            aria-pressed={s.id === activeId}
            aria-label={`${s.rw}:${s.rh} preview`}
          >
            <div className="screen" style={{ width: w }}>
              <canvas
                ref={(el) => {
                  if (el) canvases.current.set(s.id, el)
                  else canvases.current.delete(s.id)
                }}
                width={Math.round(w * devicePixelRatio)}
                height={Math.round(TILE_H * devicePixelRatio)}
                style={{ filter: graded ? 'url(#look-current)' : undefined }}
              />
              {vignette !== 'none' && <div className="vignette" style={{ background: vignette }} />}
            </div>
            <div className="caption">
              <b>
                {s.rw}:{s.rh}
              </b>
              <span className="num">{dims(ow, oh)}</span>
              {Math.abs(scale - 1) > 0.01 && (
                <span className="num muted" title={`Made from ${dims(nw, nh)} source pixels`}>
                  {scale > 1 ? `${scale.toFixed(1)}× up` : `${(1 / scale).toFixed(1)}× down`}
                </span>
              )}
            </div>
          </button>
        )
      })}
    </div>
  )
}

function drawTile(
  c: HTMLCanvasElement,
  v: HTMLVideoElement,
  s: Shape,
  src: SourceInfo,
  path: PathData | null,
  t: number,
) {
  const ctx = c.getContext('2d')
  if (!ctx) return
  // Proxy pixels per source pixel (the preview video is smaller than the source).
  const k = v.videoWidth / src.width
  const cw = c.width
  const ch = c.height
  ctx.imageSmoothingQuality = 'high'
  if (s.mode === 'fit') {
    const cover = Math.max(cw / v.videoWidth, ch / v.videoHeight)
    ctx.filter = 'blur(10px)'
    ctx.drawImage(
      v,
      (cw - v.videoWidth * cover) / 2,
      (ch - v.videoHeight * cover) / 2,
      v.videoWidth * cover,
      v.videoHeight * cover,
    )
    ctx.filter = 'none'
    const contain = Math.min(cw / v.videoWidth, ch / v.videoHeight)
    ctx.drawImage(
      v,
      (cw - v.videoWidth * contain) / 2,
      (ch - v.videoHeight * contain) / 2,
      v.videoWidth * contain,
      v.videoHeight * contain,
    )
    return
  }
  const [w, h] = cropWindow(src.width, src.height, s.rw, s.rh)
  const [cx, cy] = s.mode === 'follow' && path ? pathAt(path, t) : [0.5, 0.5]
  const [x, y] = windowAt(src.width, src.height, w, h, cx, cy)
  ctx.drawImage(v, x * k, y * k, w * k, h * k, 0, 0, cw, ch)
}
