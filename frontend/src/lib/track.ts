// Turns per-sample detections into one subject position per sample: who the
// camera should follow, and where their head is. Pure functions, no DOM.
import type { Analysis, Det, Sample, Seed } from '../types'

export interface Candidate {
  x: number // focus point (head when known), 0..1
  y: number
  size: number // area of the body box, 0..1
  score: number
  box: Det
}

export interface RawTrack {
  x: number[]
  y: number[]
  found: boolean[]
}

const center = (d: Det) => ({ x: d.x + d.w / 2, y: d.y + d.h / 2 })

/** People (with a face when one sits in their upper body), or faces alone in
 * close-ups, or animals and vehicles when there's nobody in the shot. */
export function candidates(s: Sample): Candidate[] {
  const out: Candidate[] = []
  const usedFaces = new Set<number>()
  for (const p of s.people) {
    if (p.s < 0.3) continue
    let best = -1
    s.faces.forEach((f, i) => {
      const c = center(f)
      const inside = c.x > p.x && c.x < p.x + p.w && c.y > p.y && c.y < p.y + p.h * 0.5
      if (inside && (best < 0 || f.s > s.faces[best].s)) best = i
    })
    if (best >= 0) usedFaces.add(best)
    const focus = best >= 0 ? center(s.faces[best]) : { x: p.x + p.w / 2, y: p.y + p.h * 0.2 }
    out.push({ ...focus, size: p.w * p.h, score: p.s, box: p })
  }
  s.faces.forEach((f, i) => {
    if (usedFaces.has(i) || f.s < 0.6) return
    const body = { x: f.x - f.w, y: f.y - f.h * 0.5, w: f.w * 3, h: f.h * 4, s: f.s }
    out.push({ ...center(f), size: Math.min(1, body.w * body.h), score: f.s, box: f })
  })
  if (out.length === 0) {
    for (const o of s.objects) {
      if (o.s < 0.45) continue
      out.push({ ...center(o), size: o.w * o.h, score: o.s, box: o })
    }
  }
  return out
}

/** Shot number for every sample, from the analysis cut times. */
export function shotOfSamples(a: Analysis): number[] {
  let shot = 0
  let next = 0
  return a.samples.map((s) => {
    while (next < a.cuts.length && a.cuts[next] <= s.t + 1e-6) {
      shot++
      next++
    }
    return shot
  })
}

export function shotAt(cuts: number[], t: number) {
  let n = 0
  while (n < cuts.length && cuts[n] <= t + 1e-6) n++
  return n
}

function prominence(c: Candidate) {
  const offCentre = Math.abs(c.x - 0.5)
  return Math.sqrt(c.size) * c.score * (1 - 0.6 * offCentre)
}

/** Distance in frame heights, so horizontal and vertical count the same. */
const dist = (a: { x: number; y: number }, b: { x: number; y: number }, aspect: number) =>
  Math.hypot((a.x - b.x) * aspect, a.y - b.y)

function nearest(cands: Candidate[], p: { x: number; y: number }, aspect: number) {
  let best: Candidate | null = null
  let bd = Infinity
  for (const c of cands) {
    const d = dist(c, p, aspect)
    if (d < bd) {
      bd = d
      best = c
    }
  }
  return best
}

export function trackSubject(a: Analysis, seeds: Seed[], target: 'one' | 'group', aspect: number): RawTrack {
  const n = a.samples.length
  const raw: RawTrack = { x: new Array(n).fill(0.5), y: new Array(n).fill(0.5), found: new Array(n).fill(false) }
  const cands = a.samples.map(candidates)

  if (target === 'group') {
    cands.forEach((cs, i) => {
      if (!cs.length) return
      const big = Math.max(...cs.map((c) => c.size))
      const keep = cs.filter((c) => c.size >= big * 0.3)
      const xs = keep.map((c) => c.x)
      raw.x[i] = (Math.min(...xs) + Math.max(...xs)) / 2
      raw.y[i] = keep.reduce((s, c) => s + c.y, 0) / keep.length
      raw.found[i] = true
    })
    return raw
  }

  const shots = shotOfSamples(a)
  const fps = a.sampleFps
  const sampleAt = (t: number) => Math.min(n - 1, Math.max(0, Math.round(t * fps)))

  // Walk from `from` towards `to` (inclusive), keeping hold of one subject.
  const walk = (from: number, to: number, start: Candidate | null) => {
    const step = from <= to ? 1 : -1
    let prev = start
    let lost = 0
    for (let i = from; step > 0 ? i <= to : i >= to; i += step) {
      const cs = cands[i]
      let pick: Candidate | null = null
      if (prev) {
        const c = nearest(cs, prev, aspect)
        const limit = 0.22 + 0.08 * lost
        const sizeJump = c ? Math.max(c.size, prev.size) / Math.max(1e-4, Math.min(c.size, prev.size)) : 1
        if (c && dist(c, prev, aspect) < limit && sizeJump < 4) pick = c
      }
      if (!pick && (!prev || lost > fps * 1.2) && cs.length) {
        // Lost them for over a second (or never had anyone): take whoever is most prominent.
        pick = cs.reduce((b, c) => (prominence(c) > prominence(b) ? c : b))
      }
      if (pick) {
        prev = pick
        lost = 0
        raw.x[i] = pick.x
        raw.y[i] = pick.y
        raw.found[i] = true
      } else {
        lost++
      }
    }
  }

  const ordered = [...seeds].sort((p, q) => p.t - q.t)
  let shotStart = 0
  while (shotStart < n) {
    let shotEnd = shotStart
    while (shotEnd + 1 < n && shots[shotEnd + 1] === shots[shotStart]) shotEnd++

    const inShot = ordered.map((s) => ({ s, i: sampleAt(s.t) })).filter(({ i }) => i >= shotStart && i <= shotEnd)
    if (!inShot.length) {
      walk(shotStart, shotEnd, null)
    } else {
      // The first pick also reaches back to the start of its shot.
      const first = inShot[0]
      const firstCand = nearest(cands[first.i], first.s, aspect)
      walk(first.i, shotStart, firstCand)
      inShot.forEach(({ s, i }, k) => {
        const end = k + 1 < inShot.length ? inShot[k + 1].i - 1 : shotEnd
        walk(i, end, nearest(cands[i], s, aspect))
      })
    }
    shotStart = shotEnd + 1
  }
  return raw
}

/** Which candidate the track is on at sample i (for highlighting in the UI). */
export function followedCandidate(s: Sample, x: number, y: number, aspect: number): Candidate | null {
  const c = nearest(candidates(s), { x, y }, aspect)
  return c && dist(c, { x, y }, aspect) < 0.08 ? c : null
}
