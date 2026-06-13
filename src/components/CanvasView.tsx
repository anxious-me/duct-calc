import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import type {
  Block,
  Doc,
  Duct,
  DuctClass,
  DuctKind,
  Pt,
  Room,
  Selection,
  Tool,
} from '../types'
import { ductSizeLabel, ductThickness, uid } from '../types'
import { INK, RETURN, SUPPLY, SYMBOL_MAP } from '../symbols/palette'
import {
  dist,
  midOfLongestSegment,
  orthoCorner,
  pointInPolygon,
  polygonArea,
  polygonCentroid,
  projectToPolyline,
  rotatePt,
  snapPt,
} from '../utils/geometry'
import { computeTally, portWorldPos } from '../utils/connectivity'
import { contentBbox } from '../utils/files'
import { LegendG, TitleBlockG } from './TitleLegend'
import { legendSize } from '../utils/files'

const CLS_COLOR: Record<DuctClass, string> = { supply: SUPPLY, return: RETURN }
const CLS_TINT: Record<DuctClass, string> = { supply: '#fdba74', return: '#93c5fd' }

interface View {
  x: number
  y: number
  s: number // pixels per world inch; 2 = 100 %
}

type Gesture =
  | { type: 'pan'; start: Pt; view: View }
  | { type: 'pinch'; ids: [number, number]; start: [Pt, Pt]; view: View }
  | { type: 'maybe-click'; start: Pt; view: View } // duct/polyroom tools: pan if dragged
  | { type: 'move-block'; id: string; start: Pt; orig: Pt; moved: boolean }
  | { type: 'move-duct'; id: string; start: Pt; orig: Pt[] }
  | { type: 'move-vertex'; kind: 'duct' | 'room'; id: string; idx: number }
  | { type: 'move-room'; id: string; start: Pt; orig: Pt[] }
  | { type: 'move-underlay'; start: Pt; orig: Pt }
  | { type: 'scale-underlay' }
  | { type: 'move-title'; start: Pt; orig: Pt }
  | { type: 'move-legend'; start: Pt; orig: Pt }
  | { type: 'rect-room'; start: Pt }
  | null

interface SnapHit {
  pt: Pt
  kind: 'port' | 'duct' | 'grid' | 'free'
  portCls?: DuctClass | 'any'
}

export interface CanvasHandle {
  finishDraft: () => void
  cancelDraft: () => void
  isDrafting: () => boolean
  zoomBy: (f: number) => void
  fitContent: () => void
  centerWorld: () => Pt
  viewBbox: () => { x: number; y: number; w: number; h: number }
  svg: () => SVGSVGElement | null
}

interface Props {
  doc: Doc
  commit: (d: Doc) => void
  preview: (d: Doc) => void
  tool: Tool
  sel: Selection
  setSel: (s: Selection) => void
  snap: boolean
  ortho: boolean
  showGrid: boolean
  ductCls: DuctClass
  ductKind: DuctKind
  pendingSymbol: string | null
  spaceDown: boolean
  onZoomChange: (pct: number) => void
  onDrafting: (active: boolean) => void
}

interface DuctDraft {
  points: Pt[]
  cls: DuctClass
  kind: DuctKind
}

export const CanvasView = forwardRef<CanvasHandle, Props>(function CanvasView(props, ref) {
  const {
    doc,
    commit,
    preview,
    tool,
    sel,
    setSel,
    snap,
    ortho,
    showGrid,
    ductCls,
    ductKind,
    pendingSymbol,
    spaceDown,
    onZoomChange,
    onDrafting,
  } = props

  const svgRef = useRef<SVGSVGElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View>({ x: 80, y: 80, s: 2 })
  const [draft, setDraft] = useState<DuctDraft | null>(null)
  const [polyDraft, setPolyDraft] = useState<Pt[] | null>(null)
  const [rectDraft, setRectDraft] = useState<{ a: Pt; b: Pt } | null>(null)
  const [hover, setHover] = useState<SnapHit | null>(null)

  const gesture = useRef<Gesture>(null)
  const pointers = useRef(new Map<number, Pt>())
  const docRef = useRef(doc)
  useEffect(() => {
    docRef.current = doc
  }, [doc])

  const gridStep = doc.gridIn / 2

  useEffect(() => onZoomChange(Math.round((view.s / 2) * 100)), [view.s, onZoomChange])
  useEffect(() => onDrafting(!!draft || !!polyDraft), [draft, polyDraft, onDrafting])

  const toWorld = (clientX: number, clientY: number): Pt => {
    const r = svgRef.current!.getBoundingClientRect()
    return { x: (clientX - r.left - view.x) / view.s, y: (clientY - r.top - view.y) / view.s }
  }

  const clampS = (s: number) => Math.min(8, Math.max(0.5, s))

  const zoomAt = useCallback((px: number, py: number, factor: number) => {
    setView((v) => {
      const s = Math.min(8, Math.max(0.5, v.s * factor))
      const k = s / v.s
      return { s, x: px - (px - v.x) * k, y: py - (py - v.y) * k }
    })
  }, [])

  // ---- snapping ----------------------------------------------------------
  const findSnap = (w: Pt): SnapHit => {
    const tol = 12 / view.s
    let best: SnapHit | null = null
    let bestD = tol
    for (const b of doc.blocks) {
      const sym = SYMBOL_MAP[b.symbolId]
      for (let i = 0; i < sym.ports.length; i++) {
        const p = portWorldPos(b, i)
        const d = dist(w, p)
        if (d < bestD) {
          bestD = d
          best = { pt: p, kind: 'port', portCls: sym.ports[i].cls }
        }
      }
    }
    if (best) return best
    for (const d of doc.ducts) {
      const proj = projectToPolyline(w, d.points)
      if (proj && proj.d < bestD) {
        bestD = proj.d
        best = { pt: proj.pt, kind: 'duct' }
      }
    }
    if (best) return best
    if (snap) return { pt: snapPt(w, gridStep), kind: 'grid' }
    return { pt: w, kind: 'free' }
  }

  // ---- hit testing -------------------------------------------------------
  const hitBlock = (w: Pt): Block | null => {
    for (let i = doc.blocks.length - 1; i >= 0; i--) {
      const b = doc.blocks[i]
      const sym = SYMBOL_MAP[b.symbolId]
      const bw = (b.w ?? sym.w) / 2 + 2
      const bh = (b.h ?? sym.h) / 2 + 2
      const local = rotatePt({ x: w.x - b.x, y: w.y - b.y }, ((360 - b.rot) % 360) as Block['rot'])
      if (Math.abs(local.x) <= bw && Math.abs(local.y) <= bh) return b
    }
    return null
  }

  const hitDuct = (w: Pt): Duct | null => {
    let best: Duct | null = null
    let bestD = Infinity
    for (const d of doc.ducts) {
      const proj = projectToPolyline(w, d.points)
      if (!proj) continue
      const tol = Math.max(ductThickness(d.size) / 2 + 2, 8 / view.s)
      if (proj.d < tol && proj.d < bestD) {
        bestD = proj.d
        best = d
      }
    }
    return best
  }

  const hitRoom = (w: Pt): Room | null => {
    for (let i = doc.rooms.length - 1; i >= 0; i--) {
      if (pointInPolygon(w, doc.rooms[i].points)) return doc.rooms[i]
    }
    return null
  }

  const hitTitle = (w: Pt) =>
    doc.title.visible &&
    w.x >= doc.title.x &&
    w.x <= doc.title.x + 300 &&
    w.y >= doc.title.y &&
    w.y <= doc.title.y + 96

  const hitLegend = (w: Pt) => {
    if (!doc.legend.visible) return false
    const { w: lw, h: lh } = legendSize(doc)
    return (
      w.x >= doc.legend.x && w.x <= doc.legend.x + lw && w.y >= doc.legend.y && w.y <= doc.legend.y + lh
    )
  }

  const hitUnderlay = (w: Pt) => {
    const u = doc.underlay
    return (
      !!u && !u.locked && w.x >= u.x && w.x <= u.x + u.w && w.y >= u.y && w.y <= u.y + u.h
    )
  }

  // ---- drafting ----------------------------------------------------------
  const finishDraftWith = (d: DuctDraft) => {
    const pts = dedupe(d.points)
    if (pts.length >= 2) {
      const duct: Duct = {
        id: uid('duct'),
        points: pts,
        cls: d.cls,
        kind: d.kind,
        size: { shape: 'round', d: 8 },
        cfm: null,
        material: d.kind === 'flex' ? 'Flex' : 'Sheet metal',
      }
      commit({ ...docRef.current, ducts: [...docRef.current.ducts, duct] })
      setSel({ type: 'duct', id: duct.id })
    }
    setDraft(null)
  }

  const finishDraft = () => {
    if (draft) finishDraftWith(draft)
    if (polyDraft) closePolyRoom(polyDraft)
  }

  const cancelDraft = () => {
    setDraft(null)
    setPolyDraft(null)
    setRectDraft(null)
  }

  const closePolyRoom = (pts: Pt[]) => {
    const clean = dedupe(pts)
    setPolyDraft(null)
    if (clean.length < 3) return
    addRoom(clean)
  }

  const addRoom = (pts: Pt[]) => {
    const room: Room = {
      id: uid('room'),
      points: pts,
      name: `Room ${docRef.current.rooms.length + 1}`,
      sqftOverride: null,
      targetCfm: null,
    }
    commit({ ...docRef.current, rooms: [...docRef.current.rooms, room] })
    setSel({ type: 'room', id: room.id })
  }

  const placeBlock = (w: Pt, symbolId: string) => {
    const sym = SYMBOL_MAP[symbolId]
    if (!sym) return
    const p = snap ? snapPt(w, gridStep) : w
    const b: Block = {
      id: uid('blk'),
      symbolId,
      x: p.x,
      y: p.y,
      rot: 0,
      label: symbolId === 'custom' ? 'Custom' : '',
      model: '',
      notes: '',
      cfm: sym.defaultCfm ?? null,
    }
    commit({ ...docRef.current, blocks: [...docRef.current.blocks, b] })
    setSel({ type: 'block', id: b.id })
  }

  useImperativeHandle(ref, () => ({
    finishDraft,
    cancelDraft,
    isDrafting: () => !!draft || !!polyDraft,
    zoomBy: (f: number) => {
      const r = wrapRef.current?.getBoundingClientRect()
      zoomAt((r?.width ?? 800) / 2, (r?.height ?? 600) / 2, f)
    },
    fitContent: () => {
      const r = wrapRef.current?.getBoundingClientRect()
      if (!r) return
      const bb = contentBbox(docRef.current)
      const s = clampS(Math.min((r.width - 60) / bb.w, (r.height - 60) / bb.h))
      setView({
        s,
        x: (r.width - bb.w * s) / 2 - bb.x * s,
        y: (r.height - bb.h * s) / 2 - bb.y * s,
      })
    },
    centerWorld: () => {
      const r = wrapRef.current?.getBoundingClientRect()
      return toWorld((r?.left ?? 0) + (r?.width ?? 800) / 2, (r?.top ?? 0) + (r?.height ?? 600) / 2)
    },
    viewBbox: () => {
      const r = wrapRef.current?.getBoundingClientRect()
      const w = (r?.width ?? 800) / view.s
      const h = (r?.height ?? 600) / view.s
      return { x: -view.x / view.s, y: -view.y / view.s, w, h }
    },
    svg: () => svgRef.current,
  }))

  // native wheel listener (React's onWheel is passive; we must preventDefault)
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      if (e.ctrlKey || !e.shiftKey) {
        zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015))
      } else {
        setView((v) => ({ ...v, x: v.x - e.deltaY, y: v.y - e.deltaX }))
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  // ---- pointer handlers --------------------------------------------------
  const screenPt = (e: React.PointerEvent): Pt => {
    const r = wrapRef.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') {
      // middle / right mouse drag pans
      gesture.current = { type: 'pan', start: screenPt(e), view }
      svgRef.current?.setPointerCapture(e.pointerId)
      return
    }
    pointers.current.set(e.pointerId, screenPt(e))
    svgRef.current?.setPointerCapture(e.pointerId)

    if (pointers.current.size === 2) {
      // second finger: switch to pinch, commit any in-flight move
      if (gesture.current && gesture.current.type.startsWith('move')) commit(docRef.current)
      const [a, b] = [...pointers.current.entries()]
      gesture.current = { type: 'pinch', ids: [a[0], b[0]], start: [a[1], b[1]], view }
      return
    }

    const sp = screenPt(e)
    const w = toWorld(e.clientX, e.clientY)

    if (spaceDown || tool === 'pan') {
      gesture.current = { type: 'pan', start: sp, view }
      return
    }

    if (tool === 'duct' || tool === 'polyroom' || pendingSymbol) {
      gesture.current = { type: 'maybe-click', start: sp, view }
      return
    }

    if (tool === 'room') {
      gesture.current = { type: 'rect-room', start: snap ? snapPt(w, gridStep) : w }
      return
    }

    // ---- select tool ----
    // vertex handles on the current selection take priority
    if (sel?.type === 'duct') {
      const d = doc.ducts.find((x) => x.id === sel.id)
      if (d) {
        const idx = d.points.findIndex((p) => dist(p, w) < 9 / view.s)
        if (idx >= 0) {
          gesture.current = { type: 'move-vertex', kind: 'duct', id: d.id, idx }
          return
        }
      }
    }
    if (sel?.type === 'room') {
      const r = doc.rooms.find((x) => x.id === sel.id)
      if (r) {
        const idx = r.points.findIndex((p) => dist(p, w) < 9 / view.s)
        if (idx >= 0) {
          gesture.current = { type: 'move-vertex', kind: 'room', id: r.id, idx }
          return
        }
      }
    }
    if (sel?.type === 'underlay' && doc.underlay && !doc.underlay.locked) {
      const u = doc.underlay
      if (dist(w, { x: u.x + u.w, y: u.y + u.h }) < 14 / view.s) {
        gesture.current = { type: 'scale-underlay' }
        return
      }
    }

    const b = hitBlock(w)
    if (b) {
      setSel({ type: 'block', id: b.id })
      gesture.current = { type: 'move-block', id: b.id, start: w, orig: { x: b.x, y: b.y }, moved: false }
      return
    }
    const d = hitDuct(w)
    if (d) {
      setSel({ type: 'duct', id: d.id })
      gesture.current = { type: 'move-duct', id: d.id, start: w, orig: d.points }
      return
    }
    if (hitTitle(w)) {
      setSel({ type: 'title' })
      gesture.current = { type: 'move-title', start: w, orig: { x: doc.title.x, y: doc.title.y } }
      return
    }
    if (hitLegend(w)) {
      setSel({ type: 'legend' })
      gesture.current = { type: 'move-legend', start: w, orig: { x: doc.legend.x, y: doc.legend.y } }
      return
    }
    const r = hitRoom(w)
    if (r) {
      setSel({ type: 'room', id: r.id })
      gesture.current = { type: 'move-room', id: r.id, start: w, orig: r.points }
      return
    }
    if (hitUnderlay(w)) {
      setSel({ type: 'underlay' })
      gesture.current = {
        type: 'move-underlay',
        start: w,
        orig: { x: doc.underlay!.x, y: doc.underlay!.y },
      }
      return
    }
    setSel(null)
    gesture.current = { type: 'pan', start: sp, view }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const sp = screenPt(e)
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, sp)
    const w = toWorld(e.clientX, e.clientY)
    const g = gesture.current

    if (tool === 'duct') setHover(findSnap(w))
    else if (tool === 'polyroom') setHover({ pt: snap ? snapPt(w, gridStep) : w, kind: 'grid' })
    else if (hover) setHover(null)

    if (!g) return
    switch (g.type) {
      case 'pan':
        setView({ ...g.view, x: g.view.x + sp.x - g.start.x, y: g.view.y + sp.y - g.start.y })
        break
      case 'pinch': {
        const a = pointers.current.get(g.ids[0])
        const b = pointers.current.get(g.ids[1])
        if (!a || !b) break
        const d0 = dist(g.start[0], g.start[1])
        const d1 = dist(a, b)
        const s = clampS(g.view.s * (d1 / Math.max(1, d0)))
        const k = s / g.view.s
        const m0 = { x: (g.start[0].x + g.start[1].x) / 2, y: (g.start[0].y + g.start[1].y) / 2 }
        const m1 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
        setView({
          s,
          x: m1.x - (m0.x - g.view.x) * k,
          y: m1.y - (m0.y - g.view.y) * k,
        })
        break
      }
      case 'maybe-click':
        if (dist(sp, g.start) > 7) {
          gesture.current = { type: 'pan', start: g.start, view: g.view }
        }
        break
      case 'move-block': {
        const dx = w.x - g.start.x
        const dy = w.y - g.start.y
        if (!g.moved && Math.hypot(dx, dy) * view.s < 4) break
        g.moved = true
        let nx = g.orig.x + dx
        let ny = g.orig.y + dy
        if (snap) {
          nx = Math.round(nx / gridStep) * gridStep
          ny = Math.round(ny / gridStep) * gridStep
        }
        preview({
          ...docRef.current,
          blocks: docRef.current.blocks.map((b) => (b.id === g.id ? { ...b, x: nx, y: ny } : b)),
        })
        break
      }
      case 'move-duct': {
        let dx = w.x - g.start.x
        let dy = w.y - g.start.y
        if (Math.hypot(dx, dy) * view.s < 4) break
        if (snap) {
          dx = Math.round(dx / gridStep) * gridStep
          dy = Math.round(dy / gridStep) * gridStep
        }
        preview({
          ...docRef.current,
          ducts: docRef.current.ducts.map((d) =>
            d.id === g.id ? { ...d, points: g.orig.map((p) => ({ x: p.x + dx, y: p.y + dy })) } : d,
          ),
        })
        break
      }
      case 'move-vertex': {
        if (g.kind === 'duct') {
          const s = findSnap(w)
          preview({
            ...docRef.current,
            ducts: docRef.current.ducts.map((d) =>
              d.id === g.id
                ? { ...d, points: d.points.map((p, i) => (i === g.idx ? s.pt : p)) }
                : d,
            ),
          })
        } else {
          const p = snap ? snapPt(w, gridStep) : w
          preview({
            ...docRef.current,
            rooms: docRef.current.rooms.map((r) =>
              r.id === g.id ? { ...r, points: r.points.map((q, i) => (i === g.idx ? p : q)) } : r,
            ),
          })
        }
        break
      }
      case 'move-room': {
        let dx = w.x - g.start.x
        let dy = w.y - g.start.y
        if (snap) {
          dx = Math.round(dx / gridStep) * gridStep
          dy = Math.round(dy / gridStep) * gridStep
        }
        preview({
          ...docRef.current,
          rooms: docRef.current.rooms.map((r) =>
            r.id === g.id ? { ...r, points: g.orig.map((p) => ({ x: p.x + dx, y: p.y + dy })) } : r,
          ),
        })
        break
      }
      case 'move-underlay': {
        const u = docRef.current.underlay
        if (!u) break
        preview({
          ...docRef.current,
          underlay: { ...u, x: g.orig.x + w.x - g.start.x, y: g.orig.y + w.y - g.start.y },
        })
        break
      }
      case 'scale-underlay': {
        const u = docRef.current.underlay
        if (!u) break
        const nw = Math.max(24, w.x - u.x)
        preview({ ...docRef.current, underlay: { ...u, w: nw, h: (nw * u.h) / u.w } })
        break
      }
      case 'move-title':
        preview({
          ...docRef.current,
          title: { ...docRef.current.title, x: g.orig.x + w.x - g.start.x, y: g.orig.y + w.y - g.start.y },
        })
        break
      case 'move-legend':
        preview({
          ...docRef.current,
          legend: { ...docRef.current.legend, x: g.orig.x + w.x - g.start.x, y: g.orig.y + w.y - g.start.y },
        })
        break
      case 'rect-room': {
        const p = snap ? snapPt(w, gridStep) : w
        setRectDraft({ a: g.start, b: p })
        break
      }
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId)
    const g = gesture.current
    gesture.current = null
    if (!g) return
    if (g.type === 'pinch') return

    if (g.type === 'maybe-click') {
      const w = toWorld(e.clientX, e.clientY)
      if (pendingSymbol) {
        placeBlock(w, pendingSymbol)
        return
      }
      if (tool === 'duct') handleDuctClick(w)
      else if (tool === 'polyroom') handlePolyClick(w)
      return
    }
    if (g.type === 'rect-room') {
      const rd = rectDraft
      setRectDraft(null)
      if (rd) {
        const x0 = Math.min(rd.a.x, rd.b.x)
        const y0 = Math.min(rd.a.y, rd.b.y)
        const x1 = Math.max(rd.a.x, rd.b.x)
        const y1 = Math.max(rd.a.y, rd.b.y)
        if (x1 - x0 > 12 && y1 - y0 > 12) {
          addRoom([
            { x: x0, y: y0 },
            { x: x1, y: y0 },
            { x: x1, y: y1 },
            { x: x0, y: y1 },
          ])
        }
      }
      return
    }
    if (g.type.startsWith('move')) {
      commit(docRef.current) // no-op if nothing previewed
    }
  }

  const handleDuctClick = (w: Pt) => {
    const s = findSnap(w)
    if (!draft) {
      const cls = s.kind === 'port' && s.portCls && s.portCls !== 'any' ? s.portCls : ductCls
      setDraft({ points: [s.pt], cls, kind: ductKind })
      return
    }
    const last = draft.points[draft.points.length - 1]
    if (dist(s.pt, last) < 1) return // double-click lands here; dblclick handler finishes
    const next = [...draft.points]
    if (ortho) {
      const c = orthoCorner(last, s.pt)
      if (c) next.push(c)
    }
    next.push(s.pt)
    const d2 = { ...draft, points: next }
    if (s.kind === 'port') {
      finishDraftWith(d2) // terminating on equipment finishes the run
    } else {
      setDraft(d2)
    }
  }

  const handlePolyClick = (w: Pt) => {
    const p = snap ? snapPt(w, gridStep) : w
    if (!polyDraft) {
      setPolyDraft([p])
      return
    }
    if (polyDraft.length >= 3 && dist(p, polyDraft[0]) < 12 / view.s) {
      closePolyRoom(polyDraft)
      return
    }
    setPolyDraft([...polyDraft, p])
  }

  const onDblClick = () => {
    if (draft) finishDraftWith(draft)
    if (polyDraft) closePolyRoom(polyDraft)
  }

  // ---- derived rendering data -------------------------------------------
  const tallies = useMemo(() => {
    const m = new Map<string, boolean>()
    for (const d of doc.ducts) {
      if (d.cfm != null) {
        const t = computeTally(doc, d.id)
        if (t?.over) m.set(d.id, true)
      }
    }
    return m
  }, [doc])

  const fontWorld = Math.min(18, Math.max(4, 13 / view.s))
  const hairline = 1 / view.s

  const cursor =
    spaceDown || tool === 'pan'
      ? 'grab'
      : tool === 'select' && !pendingSymbol
        ? 'default'
        : 'crosshair'

  // ---- render ------------------------------------------------------------
  return (
    <div
      ref={wrapRef}
      className="canvas-wrap"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        const symbolId = e.dataTransfer.getData('application/x-symbol')
        if (symbolId) placeBlock(toWorld(e.clientX, e.clientY), symbolId)
      }}
    >
      <svg
        ref={svgRef}
        className="canvas-svg"
        style={{ cursor, touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDblClick}
        fontFamily="'Segoe UI', system-ui, -apple-system, sans-serif"
      >
        <g data-world transform={`translate(${view.x} ${view.y}) scale(${view.s})`}>
          {showGrid && (
            <g data-noexport>
              <defs>
                <pattern
                  id="gridMinor"
                  width={doc.gridIn}
                  height={doc.gridIn}
                  patternUnits="userSpaceOnUse"
                >
                  <path
                    d={`M ${doc.gridIn} 0 H 0 V ${doc.gridIn}`}
                    fill="none"
                    stroke="#e3ebf3"
                    strokeWidth={hairline}
                  />
                </pattern>
                <pattern
                  id="gridMajor"
                  width={doc.gridIn * 4}
                  height={doc.gridIn * 4}
                  patternUnits="userSpaceOnUse"
                >
                  <rect width={doc.gridIn * 4} height={doc.gridIn * 4} fill="url(#gridMinor)" />
                  <path
                    d={`M ${doc.gridIn * 4} 0 H 0 V ${doc.gridIn * 4}`}
                    fill="none"
                    stroke="#cfdbe8"
                    strokeWidth={hairline * 1.4}
                  />
                </pattern>
              </defs>
              <rect x={-40000} y={-40000} width={80000} height={80000} fill="url(#gridMajor)" />
            </g>
          )}

          {doc.underlay && (
            <g>
              <image
                href={doc.underlay.src}
                x={doc.underlay.x}
                y={doc.underlay.y}
                width={doc.underlay.w}
                height={doc.underlay.h}
                opacity={doc.underlay.opacity}
                preserveAspectRatio="none"
              />
              {sel?.type === 'underlay' && !doc.underlay.locked && (
                <g data-noexport>
                  <rect
                    x={doc.underlay.x}
                    y={doc.underlay.y}
                    width={doc.underlay.w}
                    height={doc.underlay.h}
                    fill="none"
                    stroke="#0ea5e9"
                    strokeWidth={2 / view.s}
                    strokeDasharray={`${6 / view.s} ${4 / view.s}`}
                  />
                  <rect
                    x={doc.underlay.x + doc.underlay.w - 7 / view.s}
                    y={doc.underlay.y + doc.underlay.h - 7 / view.s}
                    width={14 / view.s}
                    height={14 / view.s}
                    fill="#0ea5e9"
                    style={{ cursor: 'nwse-resize' }}
                  />
                </g>
              )}
            </g>
          )}

          {doc.rooms.map((r) => (
            <RoomG key={r.id} room={r} selected={sel?.type === 'room' && sel.id === r.id} view={view} />
          ))}

          {doc.ducts.map((d) => (
            <DuctG
              key={d.id}
              duct={d}
              selected={sel?.type === 'duct' && sel.id === d.id}
              over={tallies.get(d.id) ?? false}
              fontWorld={fontWorld}
              view={view}
            />
          ))}

          {doc.blocks.map((b) => (
            <BlockG key={b.id} block={b} selected={sel?.type === 'block' && sel.id === b.id} view={view} />
          ))}

          {/* connection ports while routing */}
          {(tool === 'duct' || draft) && (
            <g data-noexport pointerEvents="none">
              {doc.blocks.flatMap((b) => {
                const sym = SYMBOL_MAP[b.symbolId]
                return sym.ports.map((p, i) => {
                  const wp = portWorldPos(b, i)
                  const c = p.cls === 'return' ? RETURN : p.cls === 'supply' ? SUPPLY : '#64748b'
                  return (
                    <circle
                      key={`${b.id}_${i}`}
                      cx={wp.x}
                      cy={wp.y}
                      r={4 / view.s}
                      fill="#fff"
                      stroke={c}
                      strokeWidth={1.6 / view.s}
                    />
                  )
                })
              })}
            </g>
          )}

          {/* duct draft preview */}
          {draft && (
            <g data-noexport pointerEvents="none">
              <path
                d={pathFrom(previewPts(draft.points, hover?.pt ?? null, ortho))}
                fill="none"
                stroke={CLS_COLOR[draft.cls]}
                strokeWidth={6}
                strokeOpacity={0.55}
                strokeLinejoin="round"
                strokeLinecap="round"
                strokeDasharray={draft.kind === 'flex' ? '7 4' : undefined}
              />
              {draft.points.map((p, i) => (
                <circle key={i} cx={p.x} cy={p.y} r={3.5 / view.s} fill={CLS_COLOR[draft.cls]} />
              ))}
            </g>
          )}

          {/* polygon room draft */}
          {polyDraft && (
            <g data-noexport pointerEvents="none">
              <path
                d={pathFrom(hover ? [...polyDraft, hover.pt] : polyDraft)}
                fill="rgba(100,116,139,.08)"
                stroke="#475569"
                strokeWidth={2}
                strokeDasharray="5 3"
              />
              {polyDraft.map((p, i) => (
                <circle key={i} cx={p.x} cy={p.y} r={3.5 / view.s} fill="#475569" />
              ))}
            </g>
          )}

          {/* rectangle room draft */}
          {rectDraft && (
            <rect
              data-noexport
              pointerEvents="none"
              x={Math.min(rectDraft.a.x, rectDraft.b.x)}
              y={Math.min(rectDraft.a.y, rectDraft.b.y)}
              width={Math.abs(rectDraft.b.x - rectDraft.a.x)}
              height={Math.abs(rectDraft.b.y - rectDraft.a.y)}
              fill="rgba(100,116,139,.08)"
              stroke="#475569"
              strokeWidth={2}
              strokeDasharray="5 3"
            />
          )}

          {/* snap indicator */}
          {hover && (tool === 'duct' || tool === 'polyroom') && hover.kind !== 'free' && (
            <circle
              data-noexport
              pointerEvents="none"
              cx={hover.pt.x}
              cy={hover.pt.y}
              r={(hover.kind === 'grid' ? 3 : 6) / view.s}
              fill="none"
              stroke={hover.kind === 'duct' ? '#9333ea' : '#0ea5e9'}
              strokeWidth={2 / view.s}
            />
          )}

          {doc.legend.visible && <LegendG doc={doc} selected={sel?.type === 'legend'} />}
          {doc.title.visible && <TitleBlockG doc={doc} selected={sel?.type === 'title'} />}
        </g>
      </svg>
    </div>
  )
})

// ---- helpers & subcomponents ----------------------------------------------

function dedupe(pts: Pt[]): Pt[] {
  const out: Pt[] = []
  for (const p of pts) {
    if (!out.length || dist(out[out.length - 1], p) > 0.75) out.push(p)
  }
  return out
}

function previewPts(pts: Pt[], hover: Pt | null, ortho: boolean): Pt[] {
  if (!hover) return pts
  const last = pts[pts.length - 1]
  const c = ortho ? orthoCorner(last, hover) : null
  return c ? [...pts, c, hover] : [...pts, hover]
}

function pathFrom(pts: Pt[]): string {
  if (!pts.length) return ''
  return `M ${pts[0].x} ${pts[0].y}` + pts.slice(1).map((p) => ` L ${p.x} ${p.y}`).join('')
}

function arrowAt(pts: Pt[], color: string, th: number): ReactNode {
  if (pts.length < 2) return null
  const a = pts[pts.length - 2]
  const b = pts[pts.length - 1]
  const ang = Math.atan2(b.y - a.y, b.x - a.x)
  const L = Math.max(7, th * 1.15)
  const sp = 0.5
  return (
    <path
      d={`M ${b.x - L * Math.cos(ang - sp)} ${b.y - L * Math.sin(ang - sp)} L ${b.x + L * 0.6 * Math.cos(ang)} ${b.y + L * 0.6 * Math.sin(ang)} L ${b.x - L * Math.cos(ang + sp)} ${b.y - L * Math.sin(ang + sp)} Z`}
      fill={color}
    />
  )
}

function DuctG({
  duct,
  selected,
  over,
  fontWorld,
  view,
}: {
  duct: Duct
  selected: boolean
  over: boolean
  fontWorld: number
  view: View
}) {
  const th = ductThickness(duct.size)
  const color = over ? '#dc2626' : CLS_COLOR[duct.cls]
  const tint = over ? '#fca5a5' : CLS_TINT[duct.cls]
  const d = pathFrom(duct.points)
  const mid = midOfLongestSegment(duct.points)
  const label = `${ductSizeLabel(duct.size)}${duct.cfm != null ? ` · ${duct.cfm} CFM` : ''}`
  return (
    <g>
      {selected && (
        <path
          data-noexport
          d={d}
          fill="none"
          stroke="#0ea5e9"
          strokeOpacity={0.45}
          strokeWidth={th + 7 / view.s}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}
      {duct.kind === 'rigid' ? (
        <>
          {/* solid double line: dark edges with a lighter core */}
          <path d={d} fill="none" stroke={color} strokeWidth={th} strokeLinejoin="round" strokeLinecap="butt" />
          <path
            d={d}
            fill="none"
            stroke={tint}
            strokeWidth={Math.max(1.5, th - 2.6)}
            strokeLinejoin="round"
            strokeLinecap="butt"
          />
        </>
      ) : (
        <path
          d={d}
          fill="none"
          stroke={color}
          strokeWidth={Math.max(3, th * 0.7)}
          strokeLinejoin="round"
          strokeLinecap="round"
          strokeDasharray={`${th * 0.85} ${th * 0.6}`}
        />
      )}
      {arrowAt(duct.points, color, th)}
      <text
        transform={`translate(${mid.pt.x} ${mid.pt.y - th / 2 - fontWorld * 0.45}) rotate(${mid.angle})`}
        fontSize={fontWorld}
        fontWeight={700}
        fill={color}
        textAnchor="middle"
        paintOrder="stroke"
        stroke="#fff"
        strokeWidth={fontWorld * 0.28}
        style={{ userSelect: 'none' }}
      >
        {label}
      </text>
      {selected &&
        duct.points.map((p, i) => (
          <rect
            data-noexport
            key={i}
            x={p.x - 4.5 / view.s}
            y={p.y - 4.5 / view.s}
            width={9 / view.s}
            height={9 / view.s}
            fill="#fff"
            stroke="#0ea5e9"
            strokeWidth={1.6 / view.s}
          />
        ))}
    </g>
  )
}

function BlockG({ block, selected, view }: { block: Block; selected: boolean; view: View }) {
  const sym = SYMBOL_MAP[block.symbolId]
  if (!sym) return null
  const sx = (block.w ?? sym.w) / sym.w
  const sy = (block.h ?? sym.h) / sym.h
  const bw = block.w ?? sym.w
  const bh = block.h ?? sym.h
  const rotated = block.rot === 90 || block.rot === 270
  const exW = rotated ? bh : bw
  const exH = rotated ? bw : bh
  const lines = [
    block.label,
    block.model,
    block.cfm != null && block.cfm > 0 ? `${block.cfm} CFM` : '',
  ].filter(Boolean)
  return (
    <g transform={`translate(${block.x} ${block.y})`}>
      <g transform={`rotate(${block.rot})${sx !== 1 || sy !== 1 ? ` scale(${sx} ${sy})` : ''}`}>
        {sym.render()}
      </g>
      {lines.map((t, i) => (
        <text
          key={i}
          x={0}
          y={exH / 2 + 7 + i * 7.5}
          fontSize={6.5}
          fontWeight={i === 0 ? 700 : 400}
          fill={INK}
          textAnchor="middle"
          paintOrder="stroke"
          stroke="#fff"
          strokeWidth={1.8}
          style={{ userSelect: 'none' }}
        >
          {t}
        </text>
      ))}
      {selected && (
        <rect
          data-noexport
          x={-exW / 2 - 3}
          y={-exH / 2 - 3}
          width={exW + 6}
          height={exH + 6}
          fill="none"
          stroke="#0ea5e9"
          strokeWidth={1.6 / view.s}
          strokeDasharray={`${5 / view.s} ${3 / view.s}`}
        />
      )}
    </g>
  )
}

function RoomG({ room, selected, view }: { room: Room; selected: boolean; view: View }) {
  const c = polygonCentroid(room.points)
  const sqft = room.sqftOverride ?? Math.round(polygonArea(room.points) / 144)
  const sub = [`${sqft} sq ft`, room.targetCfm != null ? `${room.targetCfm} CFM target` : '']
    .filter(Boolean)
    .join(' · ')
  return (
    <g>
      <path
        d={pathFrom(room.points) + ' Z'}
        fill="rgba(71,85,105,.07)"
        stroke="#334155"
        strokeWidth={2}
        strokeLinejoin="miter"
      />
      <text
        x={c.x}
        y={c.y - 4}
        fontSize={10}
        fontWeight={700}
        fill="#334155"
        textAnchor="middle"
        paintOrder="stroke"
        stroke="#fff"
        strokeWidth={2.4}
        style={{ userSelect: 'none' }}
      >
        {room.name}
      </text>
      <text
        x={c.x}
        y={c.y + 7}
        fontSize={7}
        fill="#64748b"
        textAnchor="middle"
        paintOrder="stroke"
        stroke="#fff"
        strokeWidth={1.8}
        style={{ userSelect: 'none' }}
      >
        {sub}
      </text>
      {selected &&
        room.points.map((p, i) => (
          <rect
            data-noexport
            key={i}
            x={p.x - 4.5 / view.s}
            y={p.y - 4.5 / view.s}
            width={9 / view.s}
            height={9 / view.s}
            fill="#fff"
            stroke="#0ea5e9"
            strokeWidth={1.6 / view.s}
          />
        ))}
    </g>
  )
}
