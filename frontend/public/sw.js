// Reframe service worker.
// - Keeps the app shell and the big tracking files (MediaPipe ~20 MB) on the
//   phone, so the app opens instantly and works when the Mac is asleep.
// - Never caches /api: videos, edits and renders always come live from the Mac.
// - Receives videos and links from the Android share sheet.
// - Shows "render finished" notifications.

const SHELL = 'reframe-shell-v2'
const ASSETS = 'reframe-assets-v1'
const SHARE = 'reframe-share'
const KEEP = [SHELL, ASSETS, SHARE]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) =>
        c.addAll(['/', '/manifest.webmanifest', '/favicon.svg', '/icons/icon-192.png', '/icons/badge-96.png']),
      ),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (!KEEP.includes(key)) await caches.delete(key)
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (req.method === 'POST' && url.pathname === '/share-target') {
    event.respondWith(receiveShare(req))
    return
  }
  if (req.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname === '/sw.js') return
  if (req.mode === 'navigate') {
    event.respondWith(appShell(req))
    return
  }
  if (/^\/(assets|mediapipe|models|icons)\//.test(url.pathname)) {
    event.respondWith(cacheFirst(req))
    return
  }
  event.respondWith(staleWhileRevalidate(req))
})

/** The newest page when the Mac answers quickly, the saved copy otherwise. */
async function appShell(req) {
  const cache = await caches.open(SHELL)
  try {
    const res = await fetchWithTimeout(req, 4000)
    if (res.ok) cache.put('/', res.clone())
    return res
  } catch {
    return (await cache.match('/')) || new Response('Reframe is offline.', { status: 503 })
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(ASSETS)
  const hit = await cache.match(req)
  if (hit) return hit
  const res = await fetch(req)
  if (res.ok && res.status === 200) cache.put(req, res.clone())
  return res
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(ASSETS)
  const hit = await cache.match(req)
  const fresh = fetch(req)
    .then((res) => {
      if (res.ok && res.status === 200) cache.put(req, res.clone())
      return res
    })
    .catch(() => hit)
  return hit || fresh
}

function fetchWithTimeout(req, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms)
    fetch(req).then(
      (r) => {
        clearTimeout(t)
        resolve(r)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

/** Share sheet → Reframe. The video or link is parked in a cache and the page
 *  asks before importing it: a hostile page can also POST here (a form
 *  navigation), so nothing is imported without a tap, and nothing is ever
 *  read from the URL. */
async function receiveShare(req) {
  try {
    const form = await req.formData()
    const cache = await caches.open(SHARE)
    await cache.delete('/shared-video')
    await cache.delete('/shared-link')
    const file = form.getAll('video').find((f) => f && typeof f === 'object' && f.size > 0)
    if (file) {
      await cache.put(
        '/shared-video',
        new Response(file, {
          headers: {
            'Content-Type': file.type || 'video/mp4',
            'X-File-Name': encodeURIComponent(file.name || 'shared-video.mp4'),
          },
        }),
      )
      return Response.redirect('/?share=1', 303)
    }
    const words = ['url', 'text', 'title'].map((k) => String(form.get(k) || '')).join(' ')
    const link = words.match(/https?:\/\/\S+/)
    if (link) {
      await cache.put('/shared-link', new Response(link[0], { headers: { 'Content-Type': 'text/plain' } }))
      return Response.redirect('/?share=1', 303)
    }
  } catch {
    /* fall through */
  }
  return Response.redirect('/?share=none', 303)
}

self.addEventListener('push', (event) => {
  let msg = { title: 'Reframe', body: '', url: '/', tag: 'reframe' }
  try {
    msg = { ...msg, ...event.data.json() }
  } catch {
    /* plain text or empty */
  }
  event.waitUntil(
    self.registration.showNotification(msg.title, {
      body: msg.body,
      tag: msg.tag,
      renotify: true,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      data: { url: msg.url },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const win = wins.find((w) => new URL(w.url).origin === self.location.origin)
      if (win) {
        win.postMessage({ type: 'open', url })
        return win.focus()
      }
      return self.clients.openWindow(url)
    })(),
  )
})
