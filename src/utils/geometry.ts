import type { Pt, Rot } from '../types'

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function rotatePt(p: Pt, rot: Rot): Pt {
  switch (rot) {
    case 90:
      return { x: -p.y, y: p.x }
    case 180:
      return { x: -p.x, y: -p.y }
    case 270:
      return { x: p.y, y: -p.x }
    default:
      return p
  }
}

export function snapTo(v: number, step: number): number {
  return Math.round(v / step) * step
}

export function snapPt(p: Pt, step: number): Pt {
  return { x: snapTo(p.x, step), y: snapTo(p.y, step) }
}

/** Closest point on segment ab to p, with distance. */
export function projectToSegment(p: Pt, a: Pt, b: Pt): { pt: Pt; d: number; t: number } {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  const pt = { x: a.x + t * dx, y: a.y + t * dy }
  return { pt, d: dist(p, pt), t }
}

/** Closest point on a polyline to p. */
export function projectToPolyline(
  p: Pt,
  pts: Pt[],
): { pt: Pt; d: number; seg: number } | null {
  let best: { pt: Pt; d: number; seg: number } | null = null
  for (let i = 0; i < pts.length - 1; i++) {
    const r = projectToSegment(p, pts[i], pts[i + 1])
    if (!best || r.d < best.d) best = { pt: r.pt, d: r.d, seg: i }
  }
  return best
}

export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x
    const yi = poly[i].y
    const xj = poly[j].x
    const yj = poly[j].y
    if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

/** Polygon area in square inches (shoelace). */
export function polygonArea(poly: Pt[]): number {
  let a = 0
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y)
  }
  return Math.abs(a / 2)
}

export function polygonCentroid(poly: Pt[]): Pt {
  let x = 0
  let y = 0
  for (const p of poly) {
    x += p.x
    y += p.y
  }
  return { x: x / poly.length, y: y / poly.length }
}

export function bboxOfPts(pts: Pt[]): { x: number; y: number; w: number; h: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of pts) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/**
 * Orthogonal bend: returns the intermediate corner between `from` and `to`
 * (horizontal-first when dx dominates), or null when already axis-aligned.
 */
export function orthoCorner(from: Pt, to: Pt): Pt | null {
  const dx = Math.abs(to.x - from.x)
  const dy = Math.abs(to.y - from.y)
  if (dx < 0.01 || dy < 0.01) return null
  return dx >= dy ? { x: to.x, y: from.y } : { x: from.x, y: to.y }
}

export function midOfLongestSegment(pts: Pt[]): { pt: Pt; angle: number } {
  let bestLen = -1
  let pt: Pt = pts[0]
  let angle = 0
  for (let i = 0; i < pts.length - 1; i++) {
    const len = dist(pts[i], pts[i + 1])
    if (len > bestLen) {
      bestLen = len
      pt = { x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 }
      let a = (Math.atan2(pts[i + 1].y - pts[i].y, pts[i + 1].x - pts[i].x) * 180) / Math.PI
      if (a > 90) a -= 180
      if (a < -90) a += 180
      angle = a
    }
  }
  return { pt, angle }
}
