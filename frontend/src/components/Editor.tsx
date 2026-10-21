import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Clapperboard } from 'lucide-react'
import { api, OfflineError } from '../api'
import { CameraProvider } from '../camera'
import { PHONE_QUERY, useMediaQuery } from '../device'
import { dims, timecode } from '../lib/format'
import { openProject } from '../nav'
import { seekTo, stepFrames, togglePlay } from '../playback'
import { useEditor } from '../store'
import type { Project } from '../types'
import { CameraPanel } from './CameraPanel'
import { ExportDrawer } from './ExportDrawer'
import { useJobs } from '../hooks'
import { LookDefs, LookPanel } from './LookPanel'
import { Monitor } from './Monitor'
import { OutputStrip } from './OutputStrip'
import { ShapesPanel } from './ShapesPanel'
import { Timeline } from './Timeline'
import { Wordmark } from './Wordmark'

export function Editor({ id }: { id: string }) {
  const project = useQuery({
    queryKey: ['project', id],
    queryFn: () => api.project(id),
    refetchInterval: (q) => (q.state.data?.status === 'importing' ? 700 : false),
  })
  const [ready, setReady] = useState(false)
  const exportOpen = useEditor((s) => s.exportOpen)
  const phone = useMediaQuery(PHONE_QUERY)
  const p = project.data

  // Load saved edits and the cached people scan once the video is ready.
  useEffect(() => {
    if (p?.status !== 'ready' || ready) return
    let live = true
    Promise.all([api.state(id), api.analysis(id)])
      .catch(() => [null, null] as const)
      .then(([saved, analysis]) => {
        if (!live) return
        useEditor.getState().load(p, saved, analysis?.version === 3 ? analysis : null)
        setReady(true)
      })
    return () => {
      live = false
    }
  }, [p, id, ready])

  useAnalysis(id, ready)
  useAutosave(id, ready)
  useShortcuts(ready)

  if (project.error) {
    const offline = project.error instanceof OfflineError
    return (
      <div className="editor">
        <TopBar />
        <Message
          title={offline ? "Can't reach your Mac" : "This video isn't here any more."}
          body={(project.error as Error).message}
        >
          {offline && (
            <button className="btn" onClick={() => project.refetch()}>
              Try again
            </button>
          )}
        </Message>
      </div>
    )
  }

  return (
    <div className="editor">
      <TopBar project={p} />
      {ready && p ? (
        <CameraProvider>
          <LookDefs />
          {phone ? (
            <PhoneWorkspace />
          ) : (
            <div className="workspace">
              <div className="stage">
                <Monitor />
                <Timeline />
                <OutputStrip />
              </div>
              <aside className="panel" aria-label="Settings">
                <ShapesPanel />
                <CameraPanel />
                <LookPanel />
              </aside>
            </div>
          )}
          {exportOpen && <ExportDrawer />}
        </CameraProvider>
      ) : (
        <Importing project={p} />
      )}
    </div>
  )
}

const PHONE_TABS = [
  { id: 'preview', label: 'Preview' },
  { id: 'shapes', label: 'Shapes' },
  { id: 'camera', label: 'Camera' },
  { id: 'look', label: 'Look' },
] as const

/** Phones: picture and timeline stay on top, tools sit in tabs underneath. */
function PhoneWorkspace() {
  const [tab, setTab] = useState<(typeof PHONE_TABS)[number]['id']>('preview')
  return (
    <div className="phone-workspace">
      <div className="phone-stage">
        <Monitor />
        <Timeline />
      </div>
      <div className="seg phone-tabs" role="tablist" aria-label="Tools">
        {PHONE_TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            aria-pressed={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="phone-panel" role="tabpanel">
        {tab === 'preview' && <OutputStrip />}
        {tab === 'shapes' && <ShapesPanel />}
        {tab === 'camera' && <CameraPanel />}
        {tab === 'look' && <LookPanel />}
      </div>
    </div>
  )
}

function TopBar({ project }: { project?: Project }) {
  const src = project?.source
  const jobs = useJobs(project?.status === 'ready' ? project.id : undefined)
  const active = jobs.data?.filter((j) => j.status === 'running' || j.status === 'queued').length ?? 0
  const setExportOpen = useEditor((s) => s.setExportOpen)
  return (
    <header className="topbar">
      <button className="btn quiet icon" aria-label="All videos" title="All videos" onClick={() => openProject(null)}>
        <ArrowLeft size={18} />
      </button>
      <Wordmark />
      {project && (
        <div className="title">
          <strong title={project.name}>{project.name}</strong>
          {src && (
            <span className="facts num">
              <span>{dims(src.width, src.height)}</span>
              <span>{Math.round(src.fps * 100) / 100} fps</span>
              <span>{timecode(src.duration, false)}</span>
              {src.hdr && <span>HDR</span>}
            </span>
          )}
        </div>
      )}
      <div className="spacer" />
      {project?.status === 'ready' && (
        <>
          {active > 0 && (
            <button className="btn quiet renders-pill" onClick={() => setExportOpen(true)}>
              Rendering <span className="count">{active}</span>
            </button>
          )}
          <button className="btn primary" onClick={() => setExportOpen(true)}>
            <Clapperboard size={16} /> Export
          </button>
        </>
      )}
    </header>
  )
}

function Importing({ project }: { project?: Project }) {
  if (!project) return <Message title="Opening video" />
  if (project.status === 'error') {
    return (
      <Message title="This video couldn't be imported." body={project.error}>
        <button className="btn" onClick={() => openProject(null)}>
          Back to all videos
        </button>
      </Message>
    )
  }
  const pct = Math.round(project.progress * 100)
  return (
    <Message title={project.stage ?? 'Importing'}>
      <div className="bar" style={{ width: 300 }}>
        <i style={{ width: `${Math.max(3, pct)}%` }} />
      </div>
      <span className="muted num">{pct}%</span>
    </Message>
  )
}

function Message({ title, body, children }: { title: string; body?: string; children?: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', placeItems: 'center', padding: 40 }}>
      <div style={{ display: 'grid', gap: 12, justifyItems: 'center', textAlign: 'center', maxWidth: 520 }}>
        <strong style={{ fontSize: 17, fontWeight: 600 }}>{title}</strong>
        {body && (
          <p className="muted" style={{ margin: 0 }}>
            {body}
          </p>
        )}
        {children}
      </div>
    </div>
  )
}

/** Runs the people scan once per video and caches it next to the project. */
function useAnalysis(id: string, ready: boolean) {
  const analysis = useEditor((s) => s.analysis)
  const analysisError = useEditor((s) => s.analysisError)
  useEffect(() => {
    if (!ready || analysis || analysisError) return
    const s = useEditor.getState()
    const duration = s.project?.source?.duration ?? 0
    const ctrl = new AbortController()
    s.setAnalyzing(0)
    // MediaPipe is big: load it only when a video needs scanning.
    import('../lib/analyze')
      .then(({ analyzeVideo }) =>
        analyzeVideo(api.proxyUrl(id), duration, (f) => useEditor.getState().setAnalyzing(f), ctrl.signal),
      )
      .then((a) => {
        useEditor.getState().setAnalysis(a)
        api.saveAnalysis(id, a).catch(() => {})
      })
      .catch((e: Error) => {
        if (e.name !== 'AbortError') useEditor.getState().setAnalyzing(null, e.message)
      })
    return () => ctrl.abort()
  }, [id, ready, analysis, analysisError])
}

function useAutosave(id: string, ready: boolean) {
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (!ready) return
    const save = () => api.saveState(id, useEditor.getState().saved()).catch(() => {})
    const unsub = useEditor.subscribe((s, prev) => {
      const changed =
        s.shapes !== prev.shapes ||
        s.activeId !== prev.activeId ||
        s.target !== prev.target ||
        s.smoothness !== prev.smoothness ||
        s.seeds !== prev.seeds ||
        s.manual !== prev.manual ||
        s.look !== prev.look ||
        s.exp !== prev.exp ||
        s.trim !== prev.trim
      if (!changed) return
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(save, 600)
    })
    return () => {
      unsub()
      if (timer.current !== undefined) {
        window.clearTimeout(timer.current)
        save()
      }
    }
  }, [id, ready])
}

function useShortcuts(ready: boolean) {
  useEffect(() => {
    if (!ready) return
    const on = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey) return
      if (e.key === ' ' && !el.closest('button')) {
        e.preventDefault()
        togglePlay()
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        const dir = e.key === 'ArrowLeft' ? -1 : 1
        if (e.shiftKey) seekTo(useEditor.getState().time + dir)
        else stepFrames(dir)
      } else if (e.key === 'Escape') {
        useEditor.getState().setExportOpen(false)
      }
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [ready])
}
