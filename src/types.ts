// World coordinates are in inches. One grid square = doc.gridIn inches.

export interface Pt {
  x: number
  y: number
}

export type DuctClass = 'supply' | 'return'
export type DuctKind = 'rigid' | 'flex'

export type DuctSize =
  | { shape: 'round'; d: number }
  | { shape: 'rect'; w: number; h: number }

export interface Duct {
  id: string
  points: Pt[]
  cls: DuctClass
  kind: DuctKind
  size: DuctSize
  cfm: number | null
  material: string
}

export type Rot = 0 | 90 | 180 | 270

export interface Block {
  id: string
  symbolId: string
  x: number
  y: number
  rot: Rot
  label: string
  model: string // model number or tonnage
  notes: string
  cfm: number | null // airflow at registers / grilles
  w?: number // size override (custom box)
  h?: number
}

export interface Room {
  id: string
  points: Pt[]
  name: string
  sqftOverride: number | null
  targetCfm: number | null
}

export interface Underlay {
  src: string // data URL
  x: number
  y: number
  w: number
  h: number
  opacity: number
  locked: boolean
}

export interface TitleBlock {
  jobName: string
  customer: string
  address: string
  date: string
  drawnBy: string
  company: string
  phone: string
  web: string
  x: number
  y: number
  visible: boolean
}

export interface LegendBox {
  x: number
  y: number
  visible: boolean
}

export type GridIn = 6 | 12 | 24

export interface Doc {
  blocks: Block[]
  ducts: Duct[]
  rooms: Room[]
  underlay: Underlay | null
  title: TitleBlock
  legend: LegendBox
  gridIn: GridIn
}

export type Selection =
  | { type: 'block'; id: string }
  | { type: 'duct'; id: string }
  | { type: 'room'; id: string }
  | { type: 'underlay' }
  | { type: 'title' }
  | { type: 'legend' }
  | null

export type Tool = 'select' | 'duct' | 'room' | 'polyroom' | 'pan'

export function ductSizeLabel(s: DuctSize): string {
  return s.shape === 'round' ? `${s.d}" rnd` : `${s.w}x${s.h}`
}

export function ductThickness(s: DuctSize): number {
  return Math.max(4, s.shape === 'round' ? s.d : s.h)
}

let counter = 0
export function uid(prefix: string): string {
  counter = (counter + 1) % 1000
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}`
}

export function todayStr(): string {
  const d = new Date()
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`
}

export function newDoc(): Doc {
  return {
    blocks: [],
    ducts: [],
    rooms: [],
    underlay: null,
    title: {
      jobName: 'New Job',
      customer: '',
      address: '',
      date: todayStr(),
      drawnBy: '',
      company: 'Silicon Valley Comfort',
      phone: '408-691-5940',
      web: 'air.systems',
      x: 40,
      y: 620,
      visible: true,
    },
    legend: { x: 760, y: 620, visible: true },
    gridIn: 12,
  }
}
