import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { api } from '../api'
import { useCamera } from '../camera-context'
import { isTouch } from '../device'
import { cropWindow, windowAt } from '../lib/geometry'
import { isIdentity, lookMatrix } from '../lib/look'
import { pathAt } from '../lib/path'
import { candidates, followedCandidate } from '../lib/track'
import { shapeColor, useEditor, videoRef } from '../store'
import type { Shape } from '../types'

export function Monitor() {
  const project = useEditor((s) => s.project)!
  const src = project.source!
  const playing = useEditor((s) => s.playing)
  const analyzing = useEditor((s) => s.analyzing)
  const analysisError = useEditor((s) => s.analysisError)
  const look = useEditor((s) => s.look)
  const bypass = useEditor((s) => s.bypassLook)
  const wrap = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const graded = !bypass && !isIdentity(lookMatrix(look))

  // Fit the source's shape into whatever room the monitor has.
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const cs = getComputedStyle(el)
      const cw = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
      const ch = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
      const k = Math.min(cw / src.width, ch / src.height)
      setSize({ w: Math.max(0, Math.floor(src.width * k)), h: Math.max(0, Math.floor(src.height * k)) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [src.width, src.height])

  // While playing, the store follows the video clock every frame.
  useEffect(() => {
    if (!playing) return
    let id = 0
    const tick = () => {
      const v = videoRef.current
      if (v) useEditor.getState().setTime(v.currentTime)
      id = requestAnimationFrame(tick)
    }
    id = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(id)
  }, [playing])

  return (
    <div className="monitor" ref={wrap} style={{ ['--src-ar' as string]: src.width / src.height }}>
      <div className="monitor-frame" style={{ width: size.w, height: size.h }}>
        <video
          ref={(el) => {
            videoRef.current = el
          }}
          src={api.proxyUrl(project.id)}
          playsInline
          preload="auto"
          style={{ filter: graded ? 'url(#look-current)' : undefined }}
          onPlay={() => useEditor.getState().setPlaying(true)}
          onPause={() => useEditor.getState().setPlaying(false)}
          onEnded={() => useEditor.getState().setPlaying(false)}
          onSeeked={(e) => useEditor.getState().setTime(e.currentTarget.currentTime)}
        />
        <Overlay pxWidth={size.w} pxHeight={size.h} />
        {analyzing !== null && (
          <div className="monitor-busy">
            <div className="busy-card" role="status">
              <strong>Finding people in the video</strong>
              <div className="bar">
                <i style={{ width: `${Math.round(analyzing * 100)}%` }} />
              </div>
              <div className="row num">
                <span>Runs once, then it's saved</span>
                <span>{Math.round(analyzing * 100)}%</span>
              </div>
            </div>
          </div>
        )}
        {analysisError && (
          <div className="monitor-busy">
            <div className="busy-card" role="alert">
              <strong>Couldn't scan the video for people</strong>
              <span className="muted">{analysisError}</span>
              <button className="btn" onClick={() => useEditor.getState().setAnalyzing(null, null)}>
                Try again
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** Frame lines and people, with one pointer handler: click a person to follow
 * them, drag the active frame to steer it (live while playing). */
function Overlay({ pxWidth, pxHeight }: { pxWidth: number; pxHeight: number }) {
  const shapes = useEditor((s) => s.shapes)
  const activeId = useEditor((s) => s.activeId)
  const time = useEditor((s) => s.time)
  const playing = useEditor((s) => s.playing)
  const show = useEditor((s) => s.showPeople)
  const analysis = useEditor((s) => s.analysis)
  const target = useEditor((s) => s.target)
  const src = useEditor((s) => s.project!.source!)
  const { path, raw } = useCamera()
  const [hover, setHover] = useState<number | null>(null)
  const [steering, setSteering] = useState(false)
  const touch = isTouch()
  const press = useRef<{
    id: number
    x: number
    y: number
    cx: number
    cy: number
    moved: boolean
    onFrame: boolean
  } | null>(null)

  const rectFor = (s: Shape): Box => {
    const [w, h] = cropWindow(src.width, src.height, s.rw, s.rh)
    const [cx, cy] = s.mode === 'follow' && path ? pathAt(path, time) : [0.5, 0.5]
    const [x, y] = windowAt(src.width, src.height, w, h, cx, cy)
    return { x: x / src.width, y: y / src.height, w: w / src.width, h: h / src.height }
  }

  const active = shapes.find((s) => s.id === activeId)
  const activeRect = active && active.mode !== 'fit' ? rectFor(active) : null
  const canSteer = active?.mode === 'follow' && !!path && !!analysis

  // People at this moment (only while paused, so the picture stays clean).
  const i = analysis ? Math.min(analysis.samples.length - 1, Math.max(0, Math.round(time * analysis.sampleFps))) : 0
  const sample = analysis?.samples[i]
  const people = analysis && sample && !playing && show ? candidates(sample) : []
  const followed =
    sample && raw && target === 'one' && raw.found[i]
      ? followedCandidate(sample, raw.x[i], raw.y[i], src.width / src.height)
      : null

  const toNorm = (e: RPointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }
  }
  const inside = (p: { x: number; y: number }, b: Box) =>
    p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h
  const personAt = (p: { x: number; y: number }) => {
    // Smallest box wins when people overlap.
    let best: number | null = null
    people.forEach((c, k) => {
      if (inside(p, c.box) && (best === null || c.box.w * c.box.h < people[best].box.w * people[best].box.h)) best = k
    })
    return best
  }

  const onDown = (e: RPointerEvent) => {
    if (e.button !== 0) return
    const p = toNorm(e)
    const onFrame = !!activeRect && canSteer && inside(p, activeRect)
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    press.current = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      cx: activeRect ? activeRect.x + activeRect.w / 2 : 0.5,
      cy: activeRect ? activeRect.y + activeRect.h / 2 : 0.5,
      moved: false,
      onFrame,
    }
  }

  const onMove = (e: RPointerEvent) => {
    const pr = press.current
    if (pr && e.buttons === 0) {
      // The release happened somewhere we didn't see (another window, a dialog).
      onUp(e)
      return
    }
    if (!pr || pr.id !== e.pointerId) {
      setHover(personAt(toNorm(e)))
      return
    }
    if (!pr.onFrame || !pxWidth) return
    if (!pr.moved && Math.hypot(e.clientX - pr.x, e.clientY - pr.y) < 4) return
    pr.moved = true
    setSteering(true)
    const cx = Math.min(1, Math.max(0, pr.cx + (e.clientX - pr.x) / pxWidth))
    const cy = Math.min(1, Math.max(0, pr.cy + (e.clientY - pr.y) / pxHeight))
    const s = useEditor.getState()
    s.steer(videoRef.current?.currentTime ?? s.time, cx, cy, s.playing)
  }

  function onUp(e: RPointerEvent) {
    const pr = press.current
    press.current = null
    if (steering) {
      setSteering(false)
      useEditor.getState().endSteer()
      return
    }
    if (!pr || pr.moved || !sample) return
    const k = personAt(toNorm(e))
    if (k !== null) useEditor.getState().addSeed({ t: sample.t, x: people[k].x, y: people[k].y })
  }

  // A drag that loses its release (window switch) must not stay stuck on.
  useEffect(() => {
    const stop = () => {
      if (!press.current) return
      press.current = null
      setSteering(false)
      useEditor.getState().endSteer()
    }
    window.addEventListener('blur', stop)
    return () => window.removeEventListener('blur', stop)
  }, [])

  const p = hover !== null ? people[hover] : undefined
  const cursor = steering ? 'grabbing' : p ? 'pointer' : canSteer ? 'grab' : 'default'
  const ordered = [...shapes].sort((a, b) => (a.id === activeId ? -1 : b.id === activeId ? 1 : 0))

  return (
    <div
      className="overlay"
      style={{ cursor }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onPointerLeave={() => !press.current && setHover(null)}
    >
      {ordered.map((s) => {
        if (s.mode === 'fit') return null
        const r = rectFor(s)
        const isActive = s.id === activeId
        return (
          <div
            key={s.id}
            className={`frameline${isActive ? ' active' : ''}`}
            style={{
              ['--c' as string]: shapeColor(s),
              left: `${r.x * 100}%`,
              top: `${r.y * 100}%`,
              width: `${r.w * 100}%`,
              height: `${r.h * 100}%`,
            }}
          >
            {isActive && <div className="corners" />}
            <span className="tag">
              {s.rw}:{s.rh}
            </span>
          </div>
        )
      })}
      {people.map((c, k) => {
        const isFollowed = followed?.box === c.box
        return (
          <div
            key={k}
            className={`person${isFollowed ? ' followed' : ''}${hover === k ? ' hover' : ''}${c.box.y < 0.08 ? ' tip-inside' : ''}`}
            style={{
              left: `${c.box.x * 100}%`,
              top: `${c.box.y * 100}%`,
              width: `${c.box.w * 100}%`,
              height: `${c.box.h * 100}%`,
            }}
          >
            {(hover === k || isFollowed || touch) && (
              <span className="follow-tip">
                {isFollowed ? 'Following' : touch ? 'Tap to follow' : 'Click to follow'}
              </span>
            )}
          </div>
        )
      })}
      {steering && (
        <div className="monitor-hint">
          {playing
            ? 'Steering live: keep the frame on your subject'
            : 'Release where the frame should be at this moment'}
        </div>
      )}
      {!steering && !playing && canSteer && hover === null && <SteerHint />}
    </div>
  )
}

function SteerHint() {
  const [seen, setSeen] = useState(() => {
    try {
      return localStorage.getItem('reframe.steerHint') === '1'
    } catch {
      return true
    }
  })
  useEffect(() => {
    if (seen) return
    const t = window.setTimeout(() => {
      setSeen(true)
      try {
        localStorage.setItem('reframe.steerHint', '1')
      } catch {
        /* private mode */
      }
    }, 7000)
    return () => window.clearTimeout(t)
  }, [seen])
  if (seen) return null
  return (
    <div className="monitor-hint">
      {isTouch()
        ? 'Tap a person to follow them. Drag the frame to steer it.'
        : 'Click a person to follow them. Drag the frame to steer it.'}
    </div>
  )
}
