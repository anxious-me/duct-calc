import type { ReactNode } from 'react'
import type { DuctClass } from '../types'

/**
 * Equipment symbol registry. Add new equipment here and it appears in the
 * sidebar palette, the legend, and the properties panel automatically.
 *
 * Symbols are drawn in local coordinates (inches) centered on the origin,
 * so a symbol of size w x h spans -w/2..w/2, -h/2..h/2. Ports are duct
 * connection points, also center-relative.
 */

export const INK = '#1f2937'
export const SUPPLY = '#f97316'
export const RETURN = '#2563eb'
export const SUPPLY_FILL = '#ffedd5'
export const RETURN_FILL = '#dbeafe'

export interface PortDef {
  x: number
  y: number
  cls: DuctClass | 'any'
}

export interface SymbolDef {
  id: string
  name: string
  category: string
  w: number
  h: number
  ports: PortDef[]
  defaultCfm?: number
  render: () => ReactNode
}

const sw = 1 // base stroke width (world inches)

function box(w: number, h: number, fill = '#fff', dash?: string): ReactNode {
  return (
    <rect
      x={-w / 2}
      y={-h / 2}
      width={w}
      height={h}
      fill={fill}
      stroke={INK}
      strokeWidth={sw}
      strokeDasharray={dash}
      rx={1}
    />
  )
}

function tag(text: string, y = 0, size = 7): ReactNode {
  return (
    <text
      x={0}
      y={y}
      fontSize={size}
      fontWeight={700}
      fill={INK}
      textAnchor="middle"
      dominantBaseline="central"
      style={{ userSelect: 'none' }}
    >
      {text}
    </text>
  )
}

function flowArrow(x1: number, y1: number, x2: number, y2: number, color = INK): ReactNode {
  const a = Math.atan2(y2 - y1, x2 - x1)
  const hl = 3.2
  return (
    <g stroke={color} strokeWidth={sw} fill="none">
      <line x1={x1} y1={y1} x2={x2} y2={y2} />
      <path
        d={`M ${x2 - hl * Math.cos(a - 0.45)} ${y2 - hl * Math.sin(a - 0.45)} L ${x2} ${y2} L ${x2 - hl * Math.cos(a + 0.45)} ${y2 - hl * Math.sin(a + 0.45)}`}
      />
    </g>
  )
}

function furnace(dir: 'up' | 'down' | 'horiz'): ReactNode {
  const w = dir === 'horiz' ? 30 : 24
  const h = dir === 'horiz' ? 24 : 30
  return (
    <g>
      {box(w, h)}
      <line
        x1={-w / 2 + 3}
        y1={-h / 2 + 4.5}
        x2={w / 2 - 3}
        y2={-h / 2 + 4.5}
        stroke={INK}
        strokeWidth={sw * 0.6}
      />
      {tag('FAU', dir === 'horiz' ? -3 : -5)}
      {dir === 'up' && flowArrow(0, 9, 0, -1, SUPPLY)}
      {dir === 'down' && flowArrow(0, -1, 0, 9, SUPPLY)}
      {dir === 'horiz' && flowArrow(-6, 6, 6, 6, SUPPLY)}
      {/* burner glyph */}
      <path
        d={
          dir === 'horiz'
            ? 'M -11 -7 q 2 -4 0 -7 q 4 3 3 7 z'
            : 'M -8 13 q 2 -4 0 -7 q 4 3 3 7 z'
        }
        fill="none"
        stroke={INK}
        strokeWidth={sw * 0.6}
      />
    </g>
  )
}

function fanUnit(label: string): ReactNode {
  return (
    <g>
      <rect x={-18} y={-18} width={36} height={36} rx={3} fill="#fff" stroke={INK} strokeWidth={sw} />
      <circle cx={0} cy={0} r={13} fill="none" stroke={INK} strokeWidth={sw} />
      <circle cx={0} cy={0} r={1.6} fill={INK} />
      {[0, 120, 240].map((a) => (
        <path
          key={a}
          d="M 0 0 Q 7 -3 11 1"
          fill="none"
          stroke={INK}
          strokeWidth={sw * 0.7}
          transform={`rotate(${a})`}
        />
      ))}
      {tag(label, 0, 6)}
    </g>
  )
}

export const SYMBOLS: SymbolDef[] = [
  {
    id: 'furnace-up',
    name: 'Furnace (upflow)',
    category: 'Equipment',
    w: 24,
    h: 30,
    ports: [
      { x: 0, y: -15, cls: 'supply' },
      { x: 0, y: 15, cls: 'return' },
      { x: -12, y: 8, cls: 'return' },
      { x: 12, y: 8, cls: 'return' },
    ],
    render: () => furnace('up'),
  },
  {
    id: 'furnace-down',
    name: 'Furnace (downflow)',
    category: 'Equipment',
    w: 24,
    h: 30,
    ports: [
      { x: 0, y: 15, cls: 'supply' },
      { x: 0, y: -15, cls: 'return' },
    ],
    render: () => furnace('down'),
  },
  {
    id: 'furnace-horiz',
    name: 'Furnace (horizontal)',
    category: 'Equipment',
    w: 30,
    h: 24,
    ports: [
      { x: 15, y: 0, cls: 'supply' },
      { x: -15, y: 0, cls: 'return' },
    ],
    render: () => furnace('horiz'),
  },
  {
    id: 'condenser',
    name: 'AC condenser',
    category: 'Equipment',
    w: 36,
    h: 36,
    ports: [],
    render: () => fanUnit('CU'),
  },
  {
    id: 'heat-pump',
    name: 'Heat pump (outdoor)',
    category: 'Equipment',
    w: 36,
    h: 36,
    ports: [],
    render: () => fanUnit('HP'),
  },
  {
    id: 'evap-coil',
    name: 'Evap coil (cased)',
    category: 'Equipment',
    w: 24,
    h: 20,
    ports: [
      { x: 0, y: -10, cls: 'supply' },
      { x: 0, y: 10, cls: 'any' },
    ],
    render: () => (
      <g>
        {box(24, 20)}
        <path d="M -8 8 L 0 -7 L 8 8 M -4 1 L 4 1" fill="none" stroke={INK} strokeWidth={sw * 0.8} />
      </g>
    ),
  },
  {
    id: 'supply-plenum',
    name: 'Supply plenum',
    category: 'Air distribution',
    w: 24,
    h: 20,
    ports: [
      { x: 0, y: -10, cls: 'supply' },
      { x: 0, y: 10, cls: 'supply' },
      { x: -12, y: 0, cls: 'supply' },
      { x: 12, y: 0, cls: 'supply' },
    ],
    render: () => (
      <g>
        {box(24, 20, SUPPLY_FILL)}
        {tag('SP')}
      </g>
    ),
  },
  {
    id: 'return-plenum',
    name: 'Return plenum',
    category: 'Air distribution',
    w: 24,
    h: 20,
    ports: [
      { x: 0, y: -10, cls: 'return' },
      { x: 0, y: 10, cls: 'return' },
      { x: -12, y: 0, cls: 'return' },
      { x: 12, y: 0, cls: 'return' },
    ],
    render: () => (
      <g>
        {box(24, 20, RETURN_FILL)}
        {tag('RP')}
      </g>
    ),
  },
  {
    id: 'return-drop',
    name: 'Return air drop',
    category: 'Air distribution',
    w: 20,
    h: 14,
    ports: [
      { x: -10, y: 0, cls: 'return' },
      { x: 10, y: 0, cls: 'return' },
      { x: 0, y: 7, cls: 'return' },
    ],
    render: () => (
      <g>
        {box(20, 14, RETURN_FILL)}
        {[-6, -2, 2, 6].map((x) => (
          <line key={x} x1={x - 3} y1={6} x2={x + 3} y2={-6} stroke={RETURN} strokeWidth={sw * 0.5} />
        ))}
        {tag('RAD', 0, 5.5)}
      </g>
    ),
  },
  {
    id: 'register-floor',
    name: 'Supply register (floor)',
    category: 'Air distribution',
    w: 14,
    h: 6,
    defaultCfm: 100,
    ports: [{ x: 0, y: 0, cls: 'supply' }],
    render: () => (
      <g>
        <rect x={-7} y={-3} width={14} height={6} rx={1.2} fill={SUPPLY_FILL} stroke={SUPPLY} strokeWidth={sw * 0.8} />
        {[-4, 0, 4].map((x) => (
          <line key={x} x1={x} y1={-2} x2={x} y2={2} stroke={SUPPLY} strokeWidth={sw * 0.45} />
        ))}
        {flowArrow(0, 4, 0, 11, SUPPLY)}
      </g>
    ),
  },
  {
    id: 'register-ceiling',
    name: 'Supply register (ceiling)',
    category: 'Air distribution',
    w: 12,
    h: 12,
    defaultCfm: 100,
    ports: [{ x: 0, y: 0, cls: 'supply' }],
    render: () => (
      <g>
        <rect x={-6} y={-6} width={12} height={12} fill={SUPPLY_FILL} stroke={SUPPLY} strokeWidth={sw * 0.8} />
        <path d="M -6 -6 L 6 6 M 6 -6 L -6 6" stroke={SUPPLY} strokeWidth={sw * 0.45} />
        <rect x={-2} y={-2} width={4} height={4} fill="#fff" stroke={SUPPLY} strokeWidth={sw * 0.45} />
        {flowArrow(6, 6, 11, 11, SUPPLY)}
      </g>
    ),
  },
  {
    id: 'return-grille',
    name: 'Return grille',
    category: 'Air distribution',
    w: 16,
    h: 7,
    defaultCfm: 0,
    ports: [{ x: 0, y: 0, cls: 'return' }],
    render: () => (
      <g>
        <rect x={-8} y={-3.5} width={16} height={7} rx={1.2} fill={RETURN_FILL} stroke={RETURN} strokeWidth={sw * 0.8} />
        {[-5.5, -2.75, 0, 2.75, 5.5].map((x) => (
          <line key={x} x1={x} y1={-2.4} x2={x} y2={2.4} stroke={RETURN} strokeWidth={sw * 0.45} />
        ))}
      </g>
    ),
  },
  {
    id: 'damper',
    name: 'Balancing damper',
    category: 'Accessories',
    w: 14,
    h: 10,
    ports: [
      { x: -7, y: 0, cls: 'any' },
      { x: 7, y: 0, cls: 'any' },
    ],
    render: () => (
      <g>
        <line x1={-7} y1={0} x2={7} y2={0} stroke={INK} strokeWidth={sw * 0.6} />
        <line x1={-3.5} y1={3.5} x2={3.5} y2={-3.5} stroke={INK} strokeWidth={sw} />
        <circle cx={0} cy={0} r={1.4} fill="#fff" stroke={INK} strokeWidth={sw * 0.6} />
        {tag('VD', -7, 5)}
      </g>
    ),
  },
  {
    id: 'flex-connect',
    name: 'Flex connection',
    category: 'Accessories',
    w: 10,
    h: 10,
    ports: [{ x: 0, y: 0, cls: 'any' }],
    render: () => (
      <g>
        <circle cx={0} cy={0} r={5} fill="#fff" stroke={INK} strokeWidth={sw * 0.8} />
        <path d="M -3 0 q 1.5 -2.5 3 0 q 1.5 2.5 3 0" fill="none" stroke={INK} strokeWidth={sw * 0.6} />
      </g>
    ),
  },
  {
    id: 'thermostat',
    name: 'Thermostat',
    category: 'Accessories',
    w: 9,
    h: 9,
    ports: [],
    render: () => (
      <g>
        <rect x={-4.5} y={-4.5} width={9} height={9} rx={2} fill="#fff" stroke={INK} strokeWidth={sw * 0.8} />
        {tag('T', 0, 6)}
      </g>
    ),
  },
  {
    id: 'custom',
    name: 'Custom box',
    category: 'Accessories',
    w: 24,
    h: 16,
    ports: [
      { x: 0, y: -8, cls: 'any' },
      { x: 0, y: 8, cls: 'any' },
      { x: -12, y: 0, cls: 'any' },
      { x: 12, y: 0, cls: 'any' },
    ],
    render: () => box(24, 16, '#f8fafc', '2.5 1.8'),
  },
]

export const SYMBOL_MAP: Record<string, SymbolDef> = Object.fromEntries(
  SYMBOLS.map((s) => [s.id, s]),
)

export const CATEGORIES = [...new Set(SYMBOLS.map((s) => s.category))]
