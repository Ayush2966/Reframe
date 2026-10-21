import { describe, expect, it } from 'vitest'
import type { Analysis, Det, Sample } from '../types'
import { cropWindow, fitCanvas, outputDims, windowAt } from './geometry'
import { IDENTITY, compose, isIdentity, lookMatrix, DEFAULT_LOOK, presetLook } from './look'
import { applyManual, densePath, emptyManual, pathAt, smoothTrack, steer } from './path'
import { candidates, trackSubject } from './track'

const person = (cx: number, w = 0.1, h = 0.5, s = 0.9): Det => ({ x: cx - w / 2, y: 0.3, w, h, s })

function analysis(people: Det[][], cuts: number[] = [], fps = 6): Analysis {
  const samples: Sample[] = people.map((p, i) => ({ t: i / fps, people: p, faces: [], objects: [] }))
  return { version: 3, sampleFps: fps, duration: people.length / fps, samples, cuts }
}

describe('geometry mirrors the Go renderer', () => {
  it('matches the backend crop windows', () => {
    expect(cropWindow(1920, 1080, 9, 16)).toEqual([608, 1080])
    expect(cropWindow(1920, 1080, 4, 5)).toEqual([864, 1080])
    expect(cropWindow(1080, 1920, 16, 9)).toEqual([1080, 608])
    expect(cropWindow(1921, 1081, 9, 16)).toEqual([608, 1080])
  })
  it('matches fit canvases and export sizes', () => {
    expect(fitCanvas(1080, 1920, 16, 9)).toEqual([3414, 1920])
    expect(outputDims(608, 1080, 9, 16, '1080')).toEqual([1080, 1920])
    expect(outputDims(608, 1080, 4, 3, '1080')).toEqual([1440, 1080])
    expect(outputDims(608, 1080, 9, 16, 'native')).toEqual([608, 1080])
  })
  it('clamps and keeps the window on even pixels', () => {
    expect(windowAt(1920, 1080, 608, 1080, 0, 0.5)).toEqual([0, 0])
    expect(windowAt(1920, 1080, 608, 1080, 0.5, 0.5)).toEqual([656, 0])
    expect(windowAt(1920, 1080, 608, 1080, 1, 0.5)).toEqual([1312, 0])
  })
})

describe('look', () => {
  it('neutral settings are the identity', () => {
    expect(isIdentity(lookMatrix(DEFAULT_LOOK))).toBe(true)
  })
  it('composes in order', () => {
    const double = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0]
    const lift = [1, 0, 0, 0.1, 0, 1, 0, 0.1, 0, 0, 1, 0.1]
    // lift then double: (v + 0.1) * 2
    expect(compose(double, lift)[3]).toBeCloseTo(0.2)
    expect(compose(IDENTITY, double)).toEqual(double)
  })
  it('mono removes colour: every row is the same', () => {
    const m = lookMatrix(presetLook('mono'))
    expect(m.slice(0, 3)).toEqual(m.slice(4, 7))
    expect(m.slice(4, 7)).toEqual(m.slice(8, 11))
  })
  it('stays inside what the renderer accepts', () => {
    const extreme = { ...DEFAULT_LOOK, brightness: 1, contrast: 1, saturation: 1, warmth: 1, tint: -1, fade: 1 }
    for (const v of lookMatrix(extreme)) expect(Math.abs(v)).toBeLessThanOrEqual(8)
  })
})

describe('tracking', () => {
  it('prefers a face inside the person for the focus point', () => {
    const s: Sample = {
      t: 0,
      people: [person(0.3)],
      faces: [{ x: 0.28, y: 0.32, w: 0.04, h: 0.06, s: 0.9 }],
      objects: [],
    }
    const [c] = candidates(s)
    expect(c.x).toBeCloseTo(0.3)
    expect(c.y).toBeCloseTo(0.35)
  })

  it('stays on the same person when someone bigger walks in', () => {
    const frames: Det[][] = []
    for (let i = 0; i < 24; i++) {
      const walker = person(0.2 + i * 0.01)
      frames.push(i < 10 ? [walker] : [walker, person(0.8, 0.2, 0.8)])
    }
    const raw = trackSubject(analysis(frames), [], 'one', 16 / 9)
    expect(raw.x[23]).toBeCloseTo(0.2 + 23 * 0.01, 2)
  })

  it('a pick follows that person for the whole shot, including before the pick', () => {
    const frames: Det[][] = []
    for (let i = 0; i < 18; i++) frames.push([person(0.25, 0.2, 0.8), person(0.75)])
    const raw = trackSubject(analysis(frames), [{ t: 2, x: 0.75, y: 0.4 }], 'one', 16 / 9)
    expect(raw.x[0]).toBeCloseTo(0.75)
    expect(raw.x[17]).toBeCloseTo(0.75)
  })

  it('group mode frames everyone', () => {
    const raw = trackSubject(analysis([[person(0.2), person(0.6)]]), [], 'group', 16 / 9)
    expect(raw.x[0]).toBeCloseTo(0.4)
  })

  it('falls back to animals and vehicles when there are no people', () => {
    const s: Sample = { t: 0, people: [], faces: [], objects: [{ x: 0.7, y: 0.4, w: 0.2, h: 0.2, s: 0.8 }] }
    expect(candidates(s)[0].x).toBeCloseTo(0.8)
  })
})

describe('camera path', () => {
  it('jumps at a cut instead of panning across it', () => {
    const frames: Det[][] = []
    for (let i = 0; i < 24; i++) frames.push([person(i < 12 ? 0.2 : 0.8)])
    const a = analysis(frames, [2])
    const smooth = smoothTrack(trackSubject(a, [], 'one', 16 / 9), a, 0.8)
    const dense = densePath(smooth, a, 30)
    expect(pathAt(dense, 1.95)[0]).toBeCloseTo(0.2, 2)
    expect(pathAt(dense, 2.0)[0]).toBeCloseTo(0.8, 2)
  })

  it('ignores a one-sample jitter', () => {
    const frames: Det[][] = []
    for (let i = 0; i < 30; i++) frames.push([person(i === 15 ? 0.55 : 0.5)])
    const a = analysis(frames)
    const smooth = smoothTrack(trackSubject(a, [], 'one', 16 / 9), a, 0.5)
    expect(Math.max(...smooth.x) - Math.min(...smooth.x)).toBeLessThan(0.005)
  })

  it('steering while paused lands exactly where you drop the frame', () => {
    const frames: Det[][] = []
    for (let i = 0; i < 30; i++) frames.push([person(0.5)])
    const a = analysis(frames)
    const auto = smoothTrack(trackSubject(a, [], 'one', 16 / 9), a, 0.5)
    const { manual } = steer(emptyManual(30), a, 2.5, 0.2, 0.5, false, null)
    const steered = applyManual(auto, manual, a)
    expect(steered.x[15]).toBeCloseTo(0.2, 1)
    expect(steered.x[0]).toBeCloseTo(0.5, 2)
  })
})
