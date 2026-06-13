import type { Block, Doc, Duct, Pt } from '../types'
import { SYMBOL_MAP } from '../symbols/palette'
import { dist, projectToPolyline, rotatePt } from './geometry'

const TOL = 3 // inches — endpoints within this distance count as connected

const SOURCE_SYMBOLS = new Set([
  'furnace-up',
  'furnace-down',
  'furnace-horiz',
  'evap-coil',
  'supply-plenum',
  'return-plenum',
  'return-drop',
])

const REGISTER_SYMBOLS = new Set(['register-floor', 'register-ceiling', 'return-grille'])

export function portWorldPos(b: Block, portIdx: number): Pt {
  const sym = SYMBOL_MAP[b.symbolId]
  const port = sym.ports[portIdx]
  const sx = (b.w ?? sym.w) / sym.w
  const sy = (b.h ?? sym.h) / sym.h
  const r = rotatePt({ x: port.x * sx, y: port.y * sy }, b.rot)
  return { x: b.x + r.x, y: b.y + r.y }
}

type Via = 'start' | 'end' | 'mid'
interface Edge {
  to: string
  via: Via // which part of the *from* duct this edge leaves through
}

function blockAnchor(b: Block): Pt[] {
  const sym = SYMBOL_MAP[b.symbolId]
  const pts = sym.ports.map((_, i) => portWorldPos(b, i))
  if (pts.length === 0) pts.push({ x: b.x, y: b.y })
  return pts
}

function buildGraph(doc: Doc): Map<string, Edge[]> {
  const adj = new Map<string, Edge[]>()
  const add = (from: string, to: string, via: Via) => {
    if (!adj.has(from)) adj.set(from, [])
    adj.get(from)!.push({ to, via })
  }

  const endpointVia = (d: Duct, p: Pt): Via => {
    if (dist(p, d.points[0]) < TOL) return 'start'
    if (dist(p, d.points[d.points.length - 1]) < TOL) return 'end'
    return 'mid'
  }

  for (const d of doc.ducts) {
    const ends: [Pt, Via][] = [
      [d.points[0], 'start'],
      [d.points[d.points.length - 1], 'end'],
    ]
    for (const [p, via] of ends) {
      for (const b of doc.blocks) {
        if (blockAnchor(b).some((ap) => dist(p, ap) < TOL)) {
          add(`d:${d.id}`, `b:${b.id}`, via)
          add(`b:${b.id}`, `d:${d.id}`, 'mid')
        }
      }
      for (const e of doc.ducts) {
        if (e.id === d.id) continue
        const proj = projectToPolyline(p, e.points)
        if (proj && proj.d < TOL) {
          add(`d:${d.id}`, `d:${e.id}`, via)
          add(`d:${e.id}`, `d:${d.id}`, endpointVia(e, proj.pt))
        }
      }
    }
  }
  return adj
}

export interface Tally {
  downstreamCfm: number
  registerCount: number
  capacity: number | null
  over: boolean
}

/**
 * Total CFM of registers fed downstream of a duct run. Upstream is the
 * endpoint whose connections lead back to equipment (furnace, plenum, coil);
 * everything reachable from the other end and from mid-run takeoffs counts.
 */
export function computeTally(doc: Doc, ductId: string): Tally | null {
  const duct = doc.ducts.find((d) => d.id === ductId)
  if (!duct) return null
  const adj = buildGraph(doc)
  const me = `d:${ductId}`
  const myEdges = adj.get(me) ?? []

  const leadsToSource = (via: Via): boolean => {
    const visited = new Set([me])
    const queue = myEdges.filter((e) => e.via === via).map((e) => e.to)
    while (queue.length) {
      const n = queue.shift()!
      if (visited.has(n)) continue
      visited.add(n)
      if (n.startsWith('b:')) {
        const b = doc.blocks.find((x) => `b:${x.id}` === n)
        if (b && SOURCE_SYMBOLS.has(b.symbolId)) return true
        continue // blocks don't propagate flow for this check
      }
      for (const e of adj.get(n) ?? []) queue.push(e.to)
    }
    return false
  }

  const upstream: Via = leadsToSource('start') ? 'start' : leadsToSource('end') ? 'end' : 'start'

  let cfm = 0
  let count = 0
  const visited = new Set([me])
  const queue = myEdges.filter((e) => e.via !== upstream).map((e) => e.to)
  while (queue.length) {
    const n = queue.shift()!
    if (visited.has(n)) continue
    visited.add(n)
    if (n.startsWith('b:')) {
      const b = doc.blocks.find((x) => `b:${x.id}` === n)
      if (!b) continue
      if (REGISTER_SYMBOLS.has(b.symbolId)) {
        cfm += b.cfm ?? 0
        count++
      }
      if (SOURCE_SYMBOLS.has(b.symbolId)) continue // don't cross equipment
      continue
    }
    for (const e of adj.get(n) ?? []) queue.push(e.to)
  }

  return {
    downstreamCfm: cfm,
    registerCount: count,
    capacity: duct.cfm,
    over: duct.cfm != null && cfm > duct.cfm,
  }
}
