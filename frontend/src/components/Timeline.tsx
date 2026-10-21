import { useMemo, useRef, type PointerEvent as RPointerEvent } from 'react'
import { Pause, Play, RotateCcw, Scissors, Users } from 'lucide-react'
import { useCamera } from '../camera-context'
import { timecode } from '../lib/format'
import { cropWindow, windowAt } from '../lib/geometry'
import { hasManual, pathAt } from '../lib/path'
import { seekTo, togglePlay } from '../playback'
import { shapeColor, useEditor } from '../store'

const VB_W = 1000
const VB_H = 56

export function Timeline() {
  const src = useEditor((s) => s.project!.source!)
  const time = useEditor((s) => s.time)
  const playing = useEditor((s) => s.playing)
  const analysis = useEditor((s) => s.analysis)
  const shapes = useEditor((s) => s.shapes)
  const activeId = useEditor((s) => s.activeId)
  const manual = useEditor((s) => s.manual)
  const seeds = useEditor((s) => s.seeds)
  const trim = useEditor((s) => s.trim)
  const showPeople = useEditor((s) => s.showPeople)
  const { path } = useCamera()
  const track = useRef<HTMLDivElement>(null)
  const dragging = useRef<'seek' | 'start' | 'end' | null>(null)
  const D = src.duration

  const activeIndex = shapes.findIndex((s) => s.id === activeId)
  const active = shapes[activeIndex]
  const color = active ? shapeColor(active) : '#fff'

  // Where the active frame sits over time, on the axis it moves along.
  const series = useMemo(() => {
    if (!path || !active || active.mode !== 'follow') return null
    const [w, h] = cropWindow(src.width, src.height, active.rw, active.rh)
    const horizontal = w < src.width
    if (!horizontal && h >= src.height) return null
    const N = 500
    const pts: string[] = []
    for (let k = 0; k <= N; k++) {
      const t = (k / N) * D
      const [cx, cy] = pathAt(path, t)
      const [x, y] = windowAt(src.width, src.height, w, h, cx, cy)
      const range = horizontal ? src.width - w : src.height - h
      const v = range > 0 ? (horizontal ? x : y) / range : 0.5
      pts.push(`${((k / N) * VB_W).toFixed(1)},${(6 + v * (VB_H - 12)).toFixed(1)}`)
    }
    return { points: pts.join(' '), horizontal }
  }, [path, active, src.width, src.height, D])

  const steered = useMemo(() => {
    if (!analysis || !manual || !hasManual(manual)) return []
    const spans: [number, number][] = []
    let start = -1
    manual.w.forEach((w, i) => {
      if (w > 0.05 && start < 0) start = i
      if ((w <= 0.05 || i === manual.w.length - 1) && start >= 0) {
        spans.push([analysis.samples[start].t, analysis.samples[i].t])
        start = -1
      }
    })
    return spans
  }, [analysis, manual])

  const xOf = (t: number) => (t / D) * 100
  const tOf = (e: RPointerEvent) => {
    const r = track.current!.getBoundingClientRect()
    return Math.min(D, Math.max(0, ((e.clientX - r.left) / r.width) * D))
  }

  const setTrimEdge = (edge: 'start' | 'end', t: number) => {
    const cur = trim ?? { start: 0, end: D }
    const next =
      edge === 'start'
        ? { start: Math.min(t, cur.end - 0.5), end: cur.end }
        : { start: cur.start, end: Math.max(t, cur.start + 0.5) }
    next.start = Math.max(0, next.start)
    next.end = Math.min(D, next.end)
    useEditor.getState().setTrim(next.start < 0.05 && next.end > D - 0.05 ? null : next)
  }

  const onDown = (e: RPointerEvent) => {
    const handle = (e.target as HTMLElement).dataset.handle as 'start' | 'end' | undefined
    dragging.current = handle ?? 'seek'
    track.current!.setPointerCapture(e.pointerId)
    if (!handle) seekTo(tOf(e))
  }
  const onMove = (e: RPointerEvent) => {
    if (!dragging.current) return
    const t = tOf(e)
    if (dragging.current === 'seek') seekTo(t)
    else setTrimEdge(dragging.current, t)
  }
  const onUp = () => {
    dragging.current = null
  }

  const s0 = trim?.start ?? 0
  const s1 = trim?.end ?? D

  return (
    <div className="timeline">
      <div className="transport">
        <button
          className="btn icon"
          onClick={togglePlay}
          aria-label={playing ? 'Pause' : 'Play'}
          title="Play or pause (Space)"
        >
          {playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <span className="tc">
          {timecode(time)} <span>/ {timecode(D)}</span>
        </span>
        <div className="spacer" />
        {trim && (
          <button
            className="btn quiet small"
            onClick={() => useEditor.getState().setTrim(null)}
            title="Export the whole video again"
          >
            <Scissors size={14} /> {timecode(trim.start)} to {timecode(trim.end)}, clear
          </button>
        )}
        {steered.length > 0 && (
          <button
            className="btn quiet small"
            onClick={() => useEditor.getState().resetSteering()}
            title="Go back to automatic framing"
          >
            <RotateCcw size={14} /> Undo steering
          </button>
        )}
        <button
          className="btn quiet small"
          aria-pressed={showPeople}
          onClick={() => useEditor.getState().setShowPeople(!showPeople)}
          title="Show the people found in each frame while paused"
          style={showPeople ? { color: 'var(--text)' } : undefined}
        >
          <Users size={14} /> People
        </button>
      </div>

      <div
        className="track"
        ref={track}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        role="slider"
        aria-label="Timeline"
        aria-valuemin={0}
        aria-valuemax={D}
        aria-valuenow={time}
        aria-valuetext={timecode(time)}
        tabIndex={0}
      >
        <svg viewBox={`0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="none" aria-hidden="true">
          {steered.map(([a, b], k) => (
            <rect
              key={k}
              x={(a / D) * VB_W}
              width={Math.max(2, ((b - a) / D) * VB_W)}
              y={0}
              height={VB_H}
              fill={color}
              opacity={0.14}
            />
          ))}
          {analysis?.cuts.map((c) => (
            <line
              key={c}
              x1={(c / D) * VB_W}
              x2={(c / D) * VB_W}
              y1={0}
              y2={VB_H}
              stroke="#7c7d82"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
              strokeDasharray="3 3"
            />
          ))}
          {series && (
            <polyline
              points={series.points}
              fill="none"
              stroke={color}
              strokeWidth={1.75}
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
            />
          )}
          {seeds.map((sd, k) => (
            <circle key={k} cx={(sd.t / D) * VB_W} cy={VB_H - 6} r={3} fill="#fff" vectorEffect="non-scaling-stroke" />
          ))}
        </svg>
        {trim && (
          <>
            <div className="outside" style={{ left: 0, width: `${xOf(s0)}%` }} />
            <div className="outside" style={{ left: `${xOf(s1)}%`, right: 0 }} />
          </>
        )}
        <button
          className="handle"
          data-handle="start"
          style={{ left: `${xOf(s0)}%` }}
          aria-label="Trim start"
          title="Drag to set where the export starts"
        />
        <button
          className="handle"
          data-handle="end"
          style={{ left: `${xOf(s1)}%` }}
          aria-label="Trim end"
          title="Drag to set where the export ends"
        />
        <div className="playhead" style={{ left: `${xOf(time)}%` }} />
      </div>

      <div className="track-legend">
        {series && (
          <span>
            <i style={{ ['--c' as string]: color }} />
            Where the {active.rw}:{active.rh} frame sits, {series.horizontal ? 'left at the top' : 'top at the top'}
          </span>
        )}
        {steered.length > 0 && (
          <span>
            <i style={{ ['--c' as string]: color, opacity: 0.4, height: 8 }} />
            Steered by hand
          </span>
        )}
        {!!analysis?.cuts.length && (
          <span>
            <i style={{ ['--c' as string]: '#7c7d82' }} />
            {analysis.cuts.length} {analysis.cuts.length === 1 ? 'cut' : 'cuts'}, the frame jumps instead of panning
          </span>
        )}
      </div>
    </div>
  )
}
