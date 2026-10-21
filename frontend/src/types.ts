export interface SourceInfo {
  width: number
  height: number
  duration: number
  fps: number
  fpsRational: string
  hasAudio: boolean
  videoCodec: string
  pixFmt: string
  bitDepth: number
  hdr: boolean
  rotation: number
  sizeBytes: number
}

export interface Project {
  id: string
  name: string
  createdAt: string
  status: 'importing' | 'ready' | 'error'
  stage?: string
  progress: number
  error?: string
  origin?: string
  source?: SourceInfo
}

export type Mode = 'follow' | 'center' | 'fit'

export interface Shape {
  id: string
  rw: number
  rh: number
  mode: Mode
}

export type SizeOption = 'native' | '1080' | '1440' | '2160'
export type EnhanceOption = 'off' | 'fast' | 'ai' | 'cloud'
export type QualityOption = 'high' | 'prores' | 'lossless'

export interface LookSettings {
  preset: string
  brightness: number
  contrast: number
  saturation: number
  warmth: number
  tint: number
  fade: number
  vignette: number
  sharpen: number
}

/** A detection box in 0..1 frame coordinates, with its confidence. */
export interface Det {
  x: number
  y: number
  w: number
  h: number
  s: number
}

export interface Sample {
  t: number
  people: Det[]
  faces: Det[]
  /** Animals and vehicles, used when nobody is in the shot. */
  objects: Det[]
}

export interface Analysis {
  version: 3
  sampleFps: number
  duration: number
  samples: Sample[]
  /** Times (seconds) where a new shot starts. */
  cuts: number[]
}

/** "Follow this one": a person the user picked at a moment in the video. */
export interface Seed {
  t: number
  x: number
  y: number
}

/** Hand steering, one value per analysis sample; w is how much it overrides. */
export interface Manual {
  x: number[]
  y: number[]
  w: number[]
}

export interface PathData {
  rate: number
  x: number[]
  y: number[]
}

export interface RenderSpec {
  projectId: string
  path: PathData
  outputs: { id: string; rw: number; rh: number; mode: Mode }[]
  look: { matrix: number[]; vignette: number; sharpen: number }
  size: SizeOption
  enhance: EnhanceOption
  quality: QualityOption
  trim?: { start: number; end: number }
}

export interface Job {
  id: string
  projectId: string
  projectName: string
  output: { id: string; rw: number; rh: number; mode: Mode }
  size: SizeOption
  enhance: EnhanceOption
  quality: QualityOption
  width: number
  height: number
  duration: number
  status: 'queued' | 'running' | 'done' | 'failed' | 'canceled'
  stage?: string
  progress: number
  etaSeconds?: number
  error?: string
  fileName?: string
  fileSize?: number
  createdAt: string
}

export interface Health {
  ffmpeg: boolean
  ytdlp: boolean
  aiLocal: boolean
  aiCloud: boolean
  aiSecondsPerMegapixel: number
}

export interface SavedState {
  shapes: Shape[]
  activeId: string
  target: 'one' | 'group'
  smoothness: number
  seeds: Seed[]
  manual: Manual | null
  look: LookSettings
  exp: { size: SizeOption; enhance: EnhanceOption; quality: QualityOption }
  trim: { start: number; end: number } | null
}

export interface PhoneStatus {
  installed: boolean
  running: boolean
  dnsName?: string
  serving: boolean
  url?: string
}
