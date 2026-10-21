// Scans the preview video in the browser: people, faces and (as a fallback)
// animals and vehicles a few times a second, plus where the shots cut.
import { FaceDetector, FilesetResolver, ObjectDetector } from '@mediapipe/tasks-vision'
import type { Analysis, Det, Sample } from '../types'

interface Detectors {
  objects: ObjectDetector
  faces: FaceDetector
}

let detectors: Promise<Detectors> | null = null

async function create(delegate: 'GPU' | 'CPU'): Promise<Detectors> {
  const fileset = await FilesetResolver.forVisionTasks('/mediapipe')
  const objects = await ObjectDetector.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: '/models/efficientdet_lite0.tflite', delegate },
    runningMode: 'IMAGE',
    scoreThreshold: 0.3,
    maxResults: 15,
  })
  const faces = await FaceDetector.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: '/models/blaze_face_short_range.tflite', delegate },
    runningMode: 'IMAGE',
    minDetectionConfidence: 0.5,
  })
  return { objects, faces }
}

function getDetectors() {
  detectors ??= create('GPU').catch(() => create('CPU'))
  detectors.catch(() => (detectors = null))
  return detectors
}

const ANIMALS = new Set(['dog', 'cat', 'horse', 'bird', 'cow', 'sheep', 'elephant', 'bear', 'zebra', 'giraffe'])
const VEHICLES = new Set([
  'car',
  'motorcycle',
  'bicycle',
  'bus',
  'truck',
  'boat',
  'airplane',
  'train',
  'skateboard',
  'surfboard',
])

function seek(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      v.removeEventListener('seeked', done)
      v.removeEventListener('error', fail)
      resolve()
    }
    const fail = () => {
      v.removeEventListener('seeked', done)
      reject(new Error('The preview video stopped loading.'))
    }
    v.addEventListener('seeked', done)
    v.addEventListener('error', fail)
    v.currentTime = t
  })
}

const TW = 32
const TH = 18

/** A tiny, area-averaged picture of the frame for spotting cuts. Shrinking in
 * two smoothed steps matters: a single big downscale point-samples, and the
 * resulting noise hides real cuts behind ordinary motion. */
function thumbnail(
  mid: CanvasRenderingContext2D,
  ctx: CanvasRenderingContext2D,
  frame: HTMLCanvasElement,
): Float32Array {
  mid.imageSmoothingQuality = 'high'
  ctx.imageSmoothingQuality = 'high'
  mid.drawImage(frame, 0, 0, mid.canvas.width, mid.canvas.height)
  ctx.drawImage(mid.canvas, 0, 0, TW, TH)
  const d = ctx.getImageData(0, 0, TW, TH).data
  const out = new Float32Array(TW * TH * 3)
  for (let i = 0; i < TW * TH; i++) {
    out[i * 3] = d[i * 4]
    out[i * 3 + 1] = d[i * 4 + 1]
    out[i * 3 + 2] = d[i * 4 + 2]
  }
  return out
}

function diff(a: Float32Array, b: Float32Array) {
  let s = 0
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i])
  return s / a.length
}

export async function analyzeVideo(
  url: string,
  duration: number,
  onProgress: (f: number) => void,
  signal: AbortSignal,
): Promise<Analysis> {
  const det = await getDetectors()
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  video.playsInline = true
  video.src = url
  await new Promise<void>((resolve, reject) => {
    video.onloadeddata = () => resolve()
    video.onerror = () => reject(new Error('The preview video could not be loaded.'))
  })

  const W = video.videoWidth
  const H = video.videoHeight
  const scale = Math.min(1, 640 / Math.max(W, H))
  const frame = document.createElement('canvas')
  frame.width = Math.round(W * scale)
  frame.height = Math.round(H * scale)
  const fctx = frame.getContext('2d', { willReadFrequently: false })!
  const thumbCanvas = document.createElement('canvas')
  thumbCanvas.width = TW
  thumbCanvas.height = TH
  const tctx = thumbCanvas.getContext('2d', { willReadFrequently: true })!
  const midCanvas = document.createElement('canvas')
  midCanvas.width = TW * 4
  midCanvas.height = TH * 4
  const mctx = midCanvas.getContext('2d')!

  const sampleFps = duration > 180 ? 4 : 6
  const count = Math.max(1, Math.floor(duration * sampleFps - 0.01) + 1)
  const samples: Sample[] = []
  const thumbs: Float32Array[] = []
  const diffs: number[] = []

  const norm = (b: { originX: number; originY: number; width: number; height: number }, s: number): Det => ({
    x: b.originX / frame.width,
    y: b.originY / frame.height,
    w: b.width / frame.width,
    h: b.height / frame.height,
    s: Math.round(s * 100) / 100,
  })

  for (let i = 0; i < count; i++) {
    if (signal.aborted) throw new DOMException('Stopped', 'AbortError')
    const t = Math.min(i / sampleFps, Math.max(0, duration - 0.05))
    await seek(video, t)
    fctx.drawImage(video, 0, 0, frame.width, frame.height)
    const objs = det.objects.detect(frame).detections
    const faces = det.faces.detect(frame).detections
    const s: Sample = { t, people: [], faces: [], objects: [] }
    for (const d of objs) {
      const cat = d.categories[0]
      if (!d.boundingBox || !cat) continue
      const box = norm(d.boundingBox, cat.score)
      if (cat.categoryName === 'person') s.people.push(box)
      else if (ANIMALS.has(cat.categoryName) || VEHICLES.has(cat.categoryName)) s.objects.push(box)
    }
    for (const f of faces) {
      if (f.boundingBox) s.faces.push(norm(f.boundingBox, f.categories[0]?.score ?? 0.5))
    }
    samples.push(s)
    thumbs.push(thumbnail(mctx, tctx, frame))
    diffs.push(i === 0 ? 0 : diff(thumbs[i], thumbs[i - 1]))
    onProgress(((i + 1) / count) * 0.92)
  }

  // A cut is a jump much bigger than the motion around it. Calibrated on real
  // footage: cuts score 4-20x the surrounding motion, busy shots under 2x.
  const cuts: number[] = []
  for (let i = 1; i < count; i++) {
    const around = diffs.slice(Math.max(1, i - 6), i).concat(diffs.slice(i + 1, i + 4))
    const typical = around.length ? around.sort((a, b) => a - b)[Math.floor(around.length / 2)] : 0
    const recent = cuts.length && samples[i].t - cuts[cuts.length - 1] < 0.35 // flashes and whips
    if (diffs[i] > 18 && diffs[i] > typical * 2.5 && !recent) {
      // Narrow it down to about a frame by bisecting between the two samples.
      let lo = samples[i - 1].t
      let hi = samples[i].t
      for (let k = 0; k < 4; k++) {
        const mid = (lo + hi) / 2
        await seek(video, mid)
        fctx.drawImage(video, 0, 0, frame.width, frame.height)
        const th = thumbnail(mctx, tctx, frame)
        if (diff(th, thumbs[i - 1]) < diff(th, thumbs[i])) lo = mid
        else hi = mid
      }
      cuts.push(Math.round(hi * 1000) / 1000)
    }
    onProgress(0.92 + (0.08 * i) / count)
  }
  video.removeAttribute('src')
  video.load()
  onProgress(1)
  return { version: 3, sampleFps, duration, samples, cuts }
}
