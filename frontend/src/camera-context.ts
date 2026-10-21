import { createContext, useContext } from 'react'
import type { SamplePath } from './lib/path'
import type { RawTrack } from './lib/track'
import type { PathData } from './types'

export interface Camera {
  raw: RawTrack | null
  samples: SamplePath | null
  path: PathData | null
  /** Share of samples where the subject was found. */
  coverage: number
}

export const CameraContext = createContext<Camera>({ raw: null, samples: null, path: null, coverage: 0 })

export const useCamera = () => useContext(CameraContext)
