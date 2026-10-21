import { useSyncExternalStore } from 'react'

/** No hover means fingers: say "tap", show hints that hover would reveal. */
export const isTouch = () => typeof matchMedia !== 'undefined' && matchMedia('(hover: none)').matches

export const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

/** Opened from the home screen rather than a browser tab. */
export const isStandalone = () =>
  matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true

/** True when the page is open on the Mac running Reframe (not on a phone over Tailscale). */
export const onThisMac = () => ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)

export function useMediaQuery(query: string) {
  return useSyncExternalStore(
    (cb) => {
      const m = matchMedia(query)
      m.addEventListener('change', cb)
      return () => m.removeEventListener('change', cb)
    },
    () => matchMedia(query).matches,
  )
}

export const PHONE_QUERY = '(max-width: 760px)'

const VIDEO_TYPES: Record<string, string> = { mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska' }

export const videoType = (name: string) => VIDEO_TYPES[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'video/mp4'

/** Phones that can hand a video file to the share sheet (Save Video, Instagram...). */
export function canShareVideo(name: string) {
  if (!isTouch() || typeof navigator.canShare !== 'function') return false
  try {
    return navigator.canShare({ files: [new File([new Blob()], name, { type: videoType(name) })] })
  } catch {
    return false
  }
}
