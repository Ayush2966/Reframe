import { lazy, Suspense, useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Link2, Smartphone, Trash2, Upload, WifiOff } from 'lucide-react'
import { api, uploadVideo } from '../api'
import { isIOS, isStandalone, isTouch, onThisMac } from '../device'
import { openProject } from '../nav'
import { dims, timecode } from '../lib/format'
import { takeSharedVideo, useInstallPrompt } from '../pwa'
import type { Project } from '../types'
import { Wordmark } from './Wordmark'

const PhoneDialog = lazy(() => import('./PhoneDialog').then((m) => ({ default: m.PhoneDialog })))

// Frame guides drawn inside the drop zone: the shapes this tool cuts out.
const GUIDES = [
  { label: '9:16', ratio: 9 / 16, color: '#F5C542' },
  { label: '1:1', ratio: 1, color: '#F07AB8' },
  { label: '4:5', ratio: 4 / 5, color: '#4FD1D9' },
]

export function Home() {
  const qc = useQueryClient()
  const health = useQuery({ queryKey: ['health'], queryFn: api.health })
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: api.projects,
    refetchInterval: (q) => (q.state.data?.some((p) => p.status === 'importing') ? 1000 : false),
  })
  const [over, setOver] = useState(false)
  const [upload, setUpload] = useState<{ name: string; progress: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [link, setLink] = useState('')
  const [phoneOpen, setPhoneOpen] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const install = useInstallPrompt()
  const touch = isTouch()

  const startUpload = async (file: File) => {
    setError(null)
    if (
      !file.type.startsWith('video/') &&
      !/\.(mp4|mov|m4v|mkv|webm|avi|mts|m2ts|ts|mxf|3gp|mpg|mpeg|wmv|flv)$/i.test(file.name)
    ) {
      setError(`${file.name} isn't a video file.`)
      return
    }
    setUpload({ name: file.name, progress: 0 })
    try {
      const p = await uploadVideo(file, (progress) => setUpload({ name: file.name, progress }))
      openProject(p.id)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setUpload(null)
    }
  }

  const importLink = useMutation({
    mutationFn: (url: string) => api.importLink(url),
    onSuccess: (p) => openProject(p.id),
    onError: (e: Error) => setError(e.message),
  })

  // Arriving from the share sheet (Android): upload the video or import the link.
  const handledShare = useRef(false)
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const share = params.get('share')
    if (!share || handledShare.current) return
    handledShare.current = true
    history.replaceState(null, '', '/' + location.hash)
    if (share === 'file') {
      takeSharedVideo().then((f) => (f ? startUpload(f) : setError("The shared video didn't come through. Try again.")))
    } else if (share === 'link' && params.get('url')) {
      importLink.mutate(params.get('url')!)
    } else {
      setError('Share a video file or a link to send it to Reframe.')
    }
    // startUpload and importLink are stable enough for a one-time hand-off.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteProject(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }),
    onError: (e: Error) => setError(e.message),
  })

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    const file = e.dataTransfer.files[0]
    if (file) startUpload(file)
  }

  const submitLink = (e: FormEvent) => {
    e.preventDefault()
    const url = link.trim()
    if (url) importLink.mutate(url)
  }

  const linksDisabled = health.data && !health.data.ytdlp

  return (
    <div className="home">
      <header className="topbar">
        <Wordmark />
        <div className="spacer" />
        {install && (
          <button className="btn" onClick={install}>
            <Download size={16} /> Install app
          </button>
        )}
        {onThisMac() && (
          <button className="btn quiet" onClick={() => setPhoneOpen(true)}>
            <Smartphone size={16} /> On your phone
          </button>
        )}
      </header>
      {phoneOpen && (
        <Suspense fallback={null}>
          <PhoneDialog onClose={() => setPhoneOpen(false)} />
        </Suspense>
      )}
      <div className="home-inner">
        {health.isError && (
          <div className="banner" role="alert">
            <WifiOff size={18} />
            <span>{(health.error as Error).message}</span>
            <button className="btn small" onClick={() => health.refetch()}>
              Try again
            </button>
          </div>
        )}
        {!onThisMac() && !isStandalone() && isIOS() && (
          <p className="banner quiet">
            Install Reframe: tap the Share button, then Add to Home Screen. It opens full screen and can notify you when
            renders finish.
          </p>
        )}
        <div
          className={`viewfinder${over ? ' over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
        >
          {GUIDES.map((g) => (
            <div key={g.label} className="guide" style={{ aspectRatio: g.ratio, ['--c' as string]: g.color }}>
              <span>{g.label}</span>
            </div>
          ))}
          <div className="drop">
            <h1>{touch ? 'Pick a video, get every shape' : 'Drop a video, get every shape'}</h1>
            <p>
              Reframe follows the person in the shot while it cuts 9:16, 4:5, 1:1 or any shape you pick, wide or tall.
            </p>
            {upload ? (
              <div style={{ width: 260, display: 'grid', gap: 8 }}>
                <div className="bar">
                  <i style={{ width: `${upload.progress * 100}%` }} />
                </div>
                <span className="muted num">
                  Uploading {upload.name} {Math.round(upload.progress * 100)}%
                </span>
              </div>
            ) : (
              <button className="btn primary" onClick={() => fileInput.current?.click()}>
                <Upload size={16} /> Choose a video
              </button>
            )}
            <input
              ref={fileInput}
              type="file"
              accept="video/*,.mkv,.mts,.m2ts,.mxf"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) startUpload(f)
              }}
            />
          </div>
        </div>

        <form className="link-row" onSubmit={submitLink}>
          <label className="sr-only" htmlFor="link">
            Video link
          </label>
          <input
            id="link"
            className="text-input"
            placeholder="Or paste a link: YouTube, Instagram, X, a direct .mp4"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            disabled={!!linksDisabled}
          />
          <button className="btn" type="submit" disabled={!link.trim() || importLink.isPending || !!linksDisabled}>
            <Link2 size={16} /> {importLink.isPending ? 'Starting' : 'Import link'}
          </button>
        </form>
        <p className="home-note">
          {linksDisabled
            ? 'Links need yt-dlp. Install it with: brew install yt-dlp'
            : 'Videos stay on this Mac. Only download things you have the rights to use.'}
        </p>
        {error && (
          <p className="home-note error-line" role="alert">
            {error}
          </p>
        )}

        <section className="library">
          <h2>Your videos</h2>
          {projects.isLoading ? null : projects.isError ? (
            <p className="empty">Your videos show up here once the Mac can be reached.</p>
          ) : !projects.data?.length ? (
            <p className="empty">Nothing here yet. Videos you add show up here so you can come back to them.</p>
          ) : (
            <div className="library-grid">
              {projects.data.map((p) => (
                <ProjectCard key={p.id} p={p} onDelete={() => remove.mutate(p.id)} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function ProjectCard({ p, onDelete }: { p: Project; onDelete: () => void }) {
  const status =
    p.status === 'importing'
      ? `${p.stage ?? 'Importing'} ${Math.round(p.progress * 100)}%`
      : p.status === 'error'
        ? "Couldn't import"
        : null
  return (
    <div className="card">
      <button className="card" onClick={() => openProject(p.id)} style={{ cursor: 'pointer' }}>
        <div className="thumb">
          {p.status === 'ready' ? (
            <img src={api.posterUrl(p.id)} alt="" loading="lazy" />
          ) : (
            <span className="muted">{status}</span>
          )}
        </div>
        <div className="name" title={p.name}>
          {p.name}
        </div>
        <div className="meta num">
          {p.source ? (
            <>
              <span>{dims(p.source.width, p.source.height)}</span>
              <span>{timecode(p.source.duration, false)}</span>
              {p.source.hdr && <span>HDR</span>}
            </>
          ) : (
            <span className={p.status === 'error' ? 'error-line' : ''}>{status}</span>
          )}
        </div>
      </button>
      {p.status !== 'importing' && (
        <button
          className="btn icon small delete"
          aria-label={`Delete ${p.name}`}
          title="Delete this video and its edits (renders stay)"
          onClick={(e) => {
            e.stopPropagation()
            if (confirm(`Delete "${p.name}"? Finished renders are kept.`)) onDelete()
          }}
        >
          <Trash2 size={14} />
        </button>
      )}
    </div>
  )
}
