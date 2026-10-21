import { useEditor, videoRef } from './store'

export function togglePlay() {
  const v = videoRef.current
  if (!v) return
  if (v.paused) {
    if (v.ended) v.currentTime = 0
    void v.play()
  } else v.pause()
}

export function seekTo(t: number) {
  const s = useEditor.getState()
  const d = s.project?.source?.duration ?? 0
  const clamped = Math.min(Math.max(0, t), Math.max(0, d - 0.001))
  if (videoRef.current) videoRef.current.currentTime = clamped
  s.setTime(clamped)
}

export function stepFrames(n: number) {
  const s = useEditor.getState()
  const fps = s.project?.source?.fps ?? 30
  videoRef.current?.pause()
  seekTo((videoRef.current?.currentTime ?? s.time) + n / fps)
}
