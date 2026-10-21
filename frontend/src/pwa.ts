// Installable app + notifications. The service worker lives in public/sw.js.
import { useSyncExternalStore } from 'react'
import { api } from './api'

type InstallPrompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> }

let installPrompt: InstallPrompt | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return
  navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('Service worker not registered:', e))
  // A tapped notification asks an open window to go to the render.
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'open' && typeof e.data.url === 'string') {
      const u = new URL(e.data.url)
      if (u.origin === location.origin) window.location.hash = u.hash || '#/'
    }
  })
  // Android/desktop Chrome: keep the install prompt for our own button.
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    installPrompt = e as InstallPrompt
    emit()
  })
  window.addEventListener('appinstalled', () => {
    installPrompt = null
    emit()
  })
}

export function useInstallPrompt() {
  const available = useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => installPrompt !== null,
  )
  return available
    ? async () => {
        await installPrompt?.prompt()
        installPrompt = null
        emit()
      }
    : null
}

// --- push notifications ----------------------------------------------------

export type PushState = 'unsupported' | 'needs-install' | 'blocked' | 'off' | 'on'

function keyBytes(base64url: string) {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4)
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

export async function pushState(): Promise<PushState> {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent)
  const standalone = matchMedia('(display-mode: standalone)').matches
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    // iPhone only offers web push to apps added to the Home Screen.
    return ios && !standalone ? 'needs-install' : 'unsupported'
  }
  if (Notification.permission === 'denied') return 'blocked'
  const reg = await navigator.serviceWorker.getRegistration()
  if (!reg) return 'unsupported'
  const sub = await reg.pushManager.getSubscription()
  return sub ? 'on' : 'off'
}

/** Must run from a tap: browsers only ask for permission after a gesture. */
export async function enablePush(): Promise<PushState> {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return permission === 'denied' ? 'blocked' : 'off'
  const reg = await navigator.serviceWorker.ready
  const { publicKey } = await api.pushKey()
  let sub = await reg.pushManager.getSubscription()
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) })
  }
  await api.pushSubscribe(sub.toJSON())
  return 'on'
}

export async function disablePush(): Promise<PushState> {
  const reg = await navigator.serviceWorker.getRegistration()
  const sub = await reg?.pushManager.getSubscription()
  if (sub) {
    await api.pushUnsubscribe(sub.endpoint).catch(() => {})
    await sub.unsubscribe()
  }
  return 'off'
}

// --- videos shared from the Android share sheet ---------------------------

/** A video the service worker received from the share sheet, if any. */
export async function takeSharedVideo(): Promise<File | null> {
  if (!('caches' in window)) return null
  const cache = await caches.open('reframe-share')
  const res = await cache.match('/shared-video')
  if (!res) return null
  const blob = await res.blob()
  await cache.delete('/shared-video')
  const name = decodeURIComponent(res.headers.get('X-File-Name') ?? 'shared-video.mp4')
  return new File([blob], name, { type: blob.type || 'video/mp4' })
}
