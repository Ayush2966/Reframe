import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, Download, FolderOpen, ScanEye, Share, Trash2, X } from 'lucide-react'
import { api } from '../api'
import { useCamera } from '../camera-context'
import { canShareVideo, onThisMac, videoType } from '../device'
import { disablePush, enablePush, pushState, type PushState } from '../pwa'
import { buildSpec, bytes, dims, duration, timecode } from '../lib/format'
import { fitCanvas, cropWindow, outputDims } from '../lib/geometry'
import { isIdentity, lookMatrix } from '../lib/look'
import { shapeColor, useEditor } from '../store'
import type { EnhanceOption, Job, QualityOption, SizeOption } from '../types'
import { CompareDialog } from './CompareDialog'
import { useJobs } from '../hooks'

const SIZES: { id: SizeOption; label: string }[] = [
  { id: 'native', label: 'Original pixels' },
  { id: '1080', label: '1080p' },
  { id: '1440', label: '1440p' },
  { id: '2160', label: '4K' },
]

export function ExportDrawer() {
  const project = useEditor((s) => s.project)!
  const src = project.source!
  const shapes = useEditor((s) => s.shapes)
  const exp = useEditor((s) => s.exp)
  const trim = useEditor((s) => s.trim)
  const look = useEditor((s) => s.look)
  const { path } = useCamera()
  const health = useQuery({ queryKey: ['health'], queryFn: api.health })
  const jobs = useJobs(project.id)
  const qc = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [tab, setTab] = useState<'settings' | 'renders'>('settings')
  const store = useEditor.getState()
  const close = () => store.setExportOpen(false)

  const length = trim ? trim.end - trim.start : src.duration
  const frames = Math.round(length * src.fps)
  const rows = shapes.map((s) => {
    const [nw, nh] =
      s.mode === 'fit' ? fitCanvas(src.width, src.height, s.rw, s.rh) : cropWindow(src.width, src.height, s.rw, s.rh)
    const [ow, oh] = outputDims(nw, nh, s.rw, s.rh, exp.size)
    return { s, nw, nh, ow, oh, gain: ow / nw }
  })
  const upscaling = rows.some((r) => r.gain > 1.05)
  const aiSeconds = rows.reduce(
    (t, r) => t + ((r.nw * r.nh) / 1e6) * frames * (health.data?.aiSecondsPerMegapixel ?? 1),
    0,
  )
  const needsFollowPath = shapes.some((s) => s.mode === 'follow')
  const graded = !isIdentity(lookMatrix(look)) || look.vignette > 0 || look.sharpen > 0
  const pixelPerfect =
    exp.size === 'native' &&
    exp.enhance === 'off' &&
    exp.quality === 'lossless' &&
    !graded &&
    rows.every((r) => r.s.mode !== 'fit')

  const render = useMutation({
    mutationFn: () => api.exportVideo(buildSpec(useEditor.getState(), path ?? { rate: 1, x: [], y: [] })),
    onSuccess: () => {
      setError(null)
      setTab('renders')
      qc.invalidateQueries({ queryKey: ['jobs', project.id] })
    },
    onError: (e: Error) => setError(e.message),
  })

  const enhanceOptions: { id: EnhanceOption; name: string; desc: React.ReactNode; disabled?: string }[] = [
    { id: 'off', name: 'None', desc: 'Resize only (Lanczos). Fine when you keep the original pixels or scale down.' },
    {
      id: 'fast',
      name: 'Clean up and sharpen',
      desc: 'Light denoise before resizing, then sharpening. Adds almost no time.',
    },
    {
      id: 'ai',
      name: 'AI upscale on this Mac',
      desc: (
        <>
          Real-ESRGAN rebuilds fine detail on your GPU. About <em>{duration(aiSeconds)}</em> for this export. Free.
        </>
      ),
      disabled: health.data && !health.data.aiLocal ? 'Not installed. Run ./scripts/setup.sh' : undefined,
    },
    {
      id: 'cloud',
      name: 'AI upscale in the cloud',
      desc: 'Topaz Video Upscale on Replicate. Best detail, much faster, billed to your Replicate account.',
      disabled: health.data && !health.data.aiCloud ? 'Add REPLICATE_API_TOKEN to .env and restart' : undefined,
    },
  ]

  const qualityOptions: { id: QualityOption; name: string; desc: string }[] = [
    {
      id: 'high',
      name: src.bitDepth > 8 && exp.enhance === 'off' ? 'MP4, HEVC 10-bit' : 'MP4, H.264',
      desc:
        src.bitDepth > 8 && exp.enhance === 'off'
          ? 'Keeps the 10-bit color and HDR of the source. Plays on phones and in apps.'
          : 'Visually lossless (CRF 14). Plays everywhere; the one to post.',
    },
    { id: 'prores', name: 'ProRes 422 HQ', desc: 'For editing in Premiere, Final Cut or Resolve. Large files (.mov).' },
    {
      id: 'lossless',
      name: 'Lossless FFV1',
      desc: 'Not a single pixel changes in compression (.mkv). Plays in VLC; huge files.',
    },
  ]

  const busy = render.isPending
  const running = jobs.data?.filter((j) => j.status === 'running' || j.status === 'queued').length ?? 0
  const canRender = !!path || !needsFollowPath

  return (
    <>
      <div className="scrim" onClick={close} />
      <aside className="drawer" role="dialog" aria-label="Export">
        <header>
          <h2>Export</h2>
          <div className="seg" role="tablist" aria-label="Export">
            <button
              role="tab"
              aria-selected={tab === 'settings'}
              aria-pressed={tab === 'settings'}
              onClick={() => setTab('settings')}
            >
              Settings
            </button>
            <button
              role="tab"
              aria-selected={tab === 'renders'}
              aria-pressed={tab === 'renders'}
              onClick={() => setTab('renders')}
            >
              Renders{running ? ` (${running} running)` : jobs.data?.length ? ` (${jobs.data.length})` : ''}
            </button>
          </div>
          <button className="btn quiet icon" onClick={close} aria-label="Close">
            <X size={18} />
          </button>
        </header>
        {tab === 'renders' ? (
          <div className="body">
            <NotifyRow />
            {!jobs.data?.length ? (
              <p className="hint" style={{ marginTop: 16 }}>
                Nothing rendered yet. Finished files show up here to download, and stay in reframe/data/renders.
              </p>
            ) : (
              jobs.data.map((j) => <JobRow key={j.id} job={j} />)
            )}
          </div>
        ) : (
          <div className="body">
            <div className="group">
              <h3>Size</h3>
              <div className="seg" role="group" aria-label="Size">
                {SIZES.map((s) => (
                  <button key={s.id} aria-pressed={exp.size === s.id} onClick={() => store.setExp({ size: s.id })}>
                    {s.label}
                  </button>
                ))}
              </div>
              <div className="dims-table">
                {rows.map((r) => (
                  <div key={r.s.id} style={{ display: 'contents', ['--c' as string]: shapeColor(r.s) }}>
                    <b>
                      {r.s.rw}:{r.s.rh}
                    </b>
                    <span className="num">
                      {Math.abs(r.gain - 1) < 0.01 ? dims(r.ow, r.oh) : `${dims(r.nw, r.nh)} to ${dims(r.ow, r.oh)}`}
                    </span>
                    <span className="gain num">
                      {Math.abs(r.gain - 1) < 0.01
                        ? 'every source pixel'
                        : r.gain > 1
                          ? `${r.gain.toFixed(2)}× bigger`
                          : `${(1 / r.gain).toFixed(2)}× smaller`}
                    </span>
                  </div>
                ))}
              </div>
              {upscaling && exp.enhance === 'off' && (
                <p className="hint" style={{ margin: 0 }}>
                  Enlarging without an enhancer only stretches the pixels. Pick one below for real detail, then use
                  Check a frame to compare.
                </p>
              )}
            </div>

            <div className="group">
              <h3>Enhance</h3>
              <div className="options" role="radiogroup" aria-label="Enhance">
                {enhanceOptions.map((o) => (
                  <label
                    key={o.id}
                    className={`option${exp.enhance === o.id ? ' selected' : ''}${o.disabled ? ' disabled' : ''}`}
                  >
                    <input
                      type="radio"
                      name="enhance"
                      checked={exp.enhance === o.id}
                      disabled={!!o.disabled}
                      onChange={() => store.setExp({ enhance: o.id })}
                    />
                    <span className="name">{o.name}</span>
                    <span className="desc">{o.disabled ?? o.desc}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="group">
              <h3>File</h3>
              <div className="options" role="radiogroup" aria-label="File type">
                {qualityOptions.map((o) => (
                  <label key={o.id} className={`option${exp.quality === o.id ? ' selected' : ''}`}>
                    <input
                      type="radio"
                      name="quality"
                      checked={exp.quality === o.id}
                      onChange={() => store.setExp({ quality: o.id })}
                    />
                    <span className="name">{o.name}</span>
                    <span className="desc">{o.desc}</span>
                  </label>
                ))}
              </div>
              {pixelPerfect && (
                <p className="hint" style={{ margin: 0 }}>
                  Every pixel in these files is identical to the source.
                </p>
              )}
            </div>

            <div className="group">
              <h3>Range</h3>
              <div className="stat">
                <span>{trim ? `${timecode(trim.start)} to ${timecode(trim.end)}` : 'The whole video'}</span>
                <span className="num muted">{timecode(length)}</span>
              </div>
              <p className="hint" style={{ margin: 0 }}>
                {trim ? (
                  <button className="link" onClick={() => store.setTrim(null)}>
                    Export the whole video
                  </button>
                ) : (
                  'Drag the handles at the ends of the timeline to export part of it.'
                )}
              </p>
            </div>
          </div>
        )}
        <footer hidden={tab !== 'settings'}>
          <span className="summary">
            {error ? (
              <span className="error-line" role="alert">
                {error}
              </span>
            ) : !canRender ? (
              'Waiting for the people scan to finish.'
            ) : (
              `${shapes.length} ${shapes.length === 1 ? 'video' : 'videos'}, ${timecode(length, false)} each`
            )}
          </span>
          <button
            className="btn"
            onClick={() => setChecking(true)}
            disabled={!canRender}
            title="Render one frame exactly as the export will look"
          >
            <ScanEye size={16} /> Check a frame
          </button>
          <button className="btn primary" onClick={() => render.mutate()} disabled={busy || !canRender}>
            {busy ? 'Starting' : `Render ${shapes.length === 1 ? 'video' : `${shapes.length} videos`}`}
          </button>
        </footer>
      </aside>
      {checking && <CompareDialog onClose={() => setChecking(false)} />}
    </>
  )
}

const ENHANCE_NAMES: Record<EnhanceOption, string> = {
  off: '',
  fast: 'sharpened',
  ai: 'AI upscaled',
  cloud: 'cloud upscaled',
}
const QUALITY_NAMES: Record<QualityOption, string> = { high: 'MP4', prores: 'ProRes', lossless: 'FFV1' }

function JobRow({ job }: { job: Job }) {
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: ['jobs', job.projectId] })
  const cancel = useMutation({ mutationFn: () => api.cancelJob(job.id), onSuccess: refresh })
  const remove = useMutation({ mutationFn: () => api.deleteJob(job.id), onSuccess: refresh })
  const reveal = useMutation({ mutationFn: () => api.revealJob(job.id) })
  const live = job.status === 'running' || job.status === 'queued'
  const pct = Math.round(job.progress * 100)
  const extras = [ENHANCE_NAMES[job.enhance], QUALITY_NAMES[job.quality]].filter(Boolean).join(', ')

  return (
    <div className="job" style={{ ['--c' as string]: shapeColor(job.output) }}>
      <span className="swatch" />
      <span className="what">
        <b>
          {job.output.rw}:{job.output.rh}
        </b>
        <span className="num">{dims(job.width, job.height)}</span>
        <span className="muted">{extras}</span>
      </span>
      <span className="actions">
        {job.status === 'done' && (
          <>
            {job.fileName && canShareVideo(job.fileName) ? (
              <SaveToPhone job={job} />
            ) : (
              <a className="btn small" href={api.jobFileUrl(job.id)} download={job.fileName} title={job.fileName}>
                <Download size={14} /> Download
              </a>
            )}
            {onThisMac() && (
              <button
                className="btn quiet icon small"
                onClick={() => reveal.mutate()}
                aria-label="Show in Finder"
                title="Show in Finder"
              >
                <FolderOpen size={14} />
              </button>
            )}
          </>
        )}
        {live ? (
          <button className="btn quiet small" onClick={() => cancel.mutate()}>
            Cancel
          </button>
        ) : (
          <button
            className="btn quiet icon small"
            onClick={() => remove.mutate()}
            aria-label="Remove render"
            title="Remove this render and its file"
          >
            <Trash2 size={14} />
          </button>
        )}
      </span>
      <div className={`status${job.status === 'failed' ? ' failed' : ''}`}>
        {job.status === 'queued' && <span>Waiting for the render before it</span>}
        {job.status === 'running' && (
          <>
            <span className="num">
              {job.stage ?? 'Rendering'}, {pct}%{job.etaSeconds ? `, about ${duration(job.etaSeconds)} left` : ''}
            </span>
            <div className={`bar${job.progress <= 0.001 ? ' indeterminate' : ''}`}>
              <i style={{ width: `${Math.max(2, pct)}%` }} />
            </div>
          </>
        )}
        {job.status === 'done' && (
          <span className="num">
            {job.fileName} {job.fileSize ? `(${bytes(job.fileSize)})` : ''}
          </span>
        )}
        {job.status === 'failed' && <span>{job.error}</span>}
        {job.status === 'canceled' && <span>Canceled</span>}
      </div>
    </div>
  )
}

/** Phones: fetch the file first, then hand it to the share sheet (Save Video,
 * Instagram, Files...). Two taps because iOS only lets a tap open the share
 * sheet straight away, and a big download takes longer than that. */
function SaveToPhone({ job }: { job: Job }) {
  const [file, setFile] = useState<File | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const name = job.fileName!

  const prepare = async () => {
    setError(null)
    setProgress(0)
    try {
      const res = await fetch(api.jobFileUrl(job.id))
      if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`)
      const total = Number(res.headers.get('Content-Length')) || job.fileSize || 0
      const reader = res.body.getReader()
      const chunks: BlobPart[] = []
      let loaded = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        loaded += value.length
        if (total) setProgress(loaded / total)
      }
      setFile(new File(chunks, name, { type: videoType(name) }))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setProgress(null)
    }
  }

  const share = async () => {
    try {
      await navigator.share({ files: [file!], title: name })
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message)
    }
  }

  if (error) {
    return (
      <a className="btn small" href={api.jobFileUrl(job.id)} download={name} title={error}>
        <Download size={14} /> Download
      </a>
    )
  }
  if (file) {
    return (
      <button className="btn small primary" onClick={share}>
        <Share size={14} /> Save or share
      </button>
    )
  }
  if (progress !== null) return <span className="num muted">Getting {Math.round(progress * 100)}%</span>
  return (
    <button className="btn small" onClick={prepare}>
      <Download size={14} /> Save to phone
    </button>
  )
}

const PUSH_TEXT: Record<PushState, string> = {
  unsupported: '',
  'needs-install':
    'Want a notification when renders finish? Add Reframe to your Home Screen first (Share, then Add to Home Screen) and open it from there.',
  blocked:
    "Notifications are blocked for Reframe. Allow them in this browser's site settings to hear when renders finish.",
  off: 'Get a notification when a render finishes, even with the app closed.',
  on: "Notifications are on. You'll hear from Reframe when a render finishes.",
}

function NotifyRow() {
  const [state, setState] = useState<PushState | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => {
    pushState()
      .then(setState)
      .catch(() => setState('unsupported'))
  }, [])
  if (!state || state === 'unsupported') return null

  const run = async (fn: () => Promise<PushState>) => {
    setBusy(true)
    setNote(null)
    try {
      setState(await fn())
    } catch (e) {
      setNote((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const test = async () => {
    const { sent } = await api.pushTest()
    setNote(
      sent ? 'Sent. It should arrive in a few seconds.' : 'No device took it. Turn notifications off and on again.',
    )
  }

  return (
    <div className="notify-row">
      <Bell size={16} />
      <div>
        <p>{PUSH_TEXT[state]}</p>
        {note && <p className="hint">{note}</p>}
      </div>
      {state === 'off' && (
        <button className="btn small" disabled={busy} onClick={() => run(enablePush)}>
          Notify me
        </button>
      )}
      {state === 'on' && (
        <span className="notify-actions">
          <button className="link" onClick={test}>
            Send a test
          </button>
          <button className="link" disabled={busy} onClick={() => run(disablePush)}>
            Turn off
          </button>
        </span>
      )}
    </div>
  )
}
