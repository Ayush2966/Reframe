import type { Analysis, Health, Job, PhoneStatus, Project, RenderSpec, SavedState } from './types'

/** The page loaded (maybe from the phone's cache) but the Mac didn't answer. */
export class OfflineError extends Error {
  constructor() {
    super("Can't reach Reframe on your Mac. Check that the Mac is awake, Reframe is running, and Tailscale is on.")
    this.name = 'OfflineError'
  }
}

async function send(path: string, init?: RequestInit) {
  try {
    return await fetch(path, init)
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    throw new OfflineError()
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await send(path, init)
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`
    try {
      const body = await res.json()
      if (body?.error) msg = body.error
    } catch {
      /* not JSON */
    }
    throw new Error(msg)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

/** Saved editor data; the server answers null when nothing is saved yet. */
async function optional<T>(path: string): Promise<T | null> {
  const res = await send(path)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json() as Promise<T | null>
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export const api = {
  health: () => request<Health>('/api/health'),
  projects: () => request<Project[]>('/api/projects'),
  project: (id: string) => request<Project>(`/api/projects/${id}`),
  deleteProject: (id: string) => request<void>(`/api/projects/${id}`, { method: 'DELETE' }),
  importLink: (url: string) => request<Project>('/api/projects/link', json({ url })),

  proxyUrl: (id: string) => `/api/projects/${id}/proxy.mp4`,
  posterUrl: (id: string) => `/api/projects/${id}/poster.jpg`,

  analysis: (id: string) => optional<Analysis>(`/api/projects/${id}/analysis`),
  saveAnalysis: (id: string, a: Analysis) =>
    request<void>(`/api/projects/${id}/analysis`, { ...json(a), method: 'PUT' }),
  state: (id: string) => optional<SavedState>(`/api/projects/${id}/state`),
  saveState: (id: string, s: SavedState) => request<void>(`/api/projects/${id}/state`, { ...json(s), method: 'PUT' }),

  /** Renders one frame exactly as the export would, as an object URL. */
  async frame(id: string, spec: RenderSpec, time: number): Promise<{ url: string; size: string }> {
    const res = await send(`/api/projects/${id}/frame`, json({ spec, time }))
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      throw new Error(body?.error ?? `${res.status} ${res.statusText}`)
    }
    return { url: URL.createObjectURL(await res.blob()), size: res.headers.get('X-Frame-Size') ?? '' }
  },

  exportVideo: (spec: RenderSpec) => request<Job[]>('/api/exports', json(spec)),
  jobs: (projectId?: string) => request<Job[]>(`/api/jobs${projectId ? `?projectId=${projectId}` : ''}`),
  cancelJob: (id: string) => request<void>(`/api/jobs/${id}/cancel`, { method: 'POST' }),
  deleteJob: (id: string) => request<void>(`/api/jobs/${id}`, { method: 'DELETE' }),
  revealJob: (id: string) => request<void>(`/api/jobs/${id}/reveal`, { method: 'POST' }),
  jobFileUrl: (id: string) => `/api/jobs/${id}/file`,

  phone: () => request<PhoneStatus>('/api/phone'),
  pushKey: () => request<{ publicKey: string; devices: number }>('/api/push'),
  pushSubscribe: (sub: PushSubscriptionJSON) => request<void>('/api/push/subscribe', json(sub)),
  pushUnsubscribe: (endpoint: string) => request<void>('/api/push/unsubscribe', json({ endpoint })),
  pushTest: () => request<{ sent: number }>('/api/push/test', { method: 'POST' }),
}

/** Uploads with progress (fetch can't report upload progress). */
export function uploadVideo(file: File, onProgress: (f: number) => void): Promise<Project> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `/api/projects/upload?name=${encodeURIComponent(file.name)}`)
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total)
    xhr.onload = () => {
      let body: { error?: string } | Project | null = null
      try {
        body = JSON.parse(xhr.responseText)
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as Project)
      else reject(new Error((body as { error?: string })?.error ?? `Upload failed (${xhr.status})`))
    }
    xhr.onerror = () =>
      reject(new Error('The upload was interrupted. Check that the Mac is awake and Reframe is running.'))
    xhr.send(file)
  })
}
