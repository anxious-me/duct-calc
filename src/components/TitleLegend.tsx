import type { Doc } from '../types'
import { CATEGORIES, INK, RETURN, SUPPLY, SYMBOLS } from '../symbols/palette'

/** Title block — permit-style bordered table, drawn in world inches. */
export function TitleBlockG({ doc, selected }: { doc: Doc; selected: boolean }) {
  const t = doc.title
  const W = 300
  const H = 96
  const leftW = 120
  const rows: [string, string][] = [
    ['JOB', t.jobName],
    ['CUSTOMER', t.customer],
    ['ADDRESS', t.address],
  ]
  const cols: [string, string][] = [
    ['DATE', t.date],
    ['DRAWN BY', t.drawnBy],
  ]
  return (
    <g data-id="title" transform={`translate(${t.x} ${t.y})`} style={{ cursor: 'move' }}>
      <rect width={W} height={H} fill="#fff" stroke={INK} strokeWidth={1.6} />
      <line x1={leftW} y1={0} x2={leftW} y2={H} stroke={INK} strokeWidth={0.8} />
      {/* company cell */}
      <text x={leftW / 2} y={30} textAnchor="middle" fontSize={13} fontWeight={800} fill={INK}>
        {t.company.split(' ').slice(0, 2).join(' ')}
      </text>
      <text x={leftW / 2} y={46} textAnchor="middle" fontSize={13} fontWeight={800} fill={INK}>
        {t.company.split(' ').slice(2).join(' ')}
      </text>
      <text x={leftW / 2} y={66} textAnchor="middle" fontSize={9} fill={INK}>
        {t.phone}
      </text>
      <text x={leftW / 2} y={80} textAnchor="middle" fontSize={9} fill={INK}>
        {t.web}
      </text>
      {/* job rows */}
      {rows.map(([k, v], i) => (
        <g key={k} transform={`translate(${leftW} ${(i * H * 0.75) / 3})`}>
          <line x1={0} y1={H / 4 * (i > 0 ? 0 : 0)} x2={0} y2={0} stroke="none" />
          <line x1={0} y1={H / 4} x2={W - leftW} y2={H / 4} stroke={INK} strokeWidth={0.5} />
          <text x={6} y={8.5} fontSize={5.5} fill="#64748b" fontWeight={600}>
            {k}
          </text>
          <text x={6} y={19} fontSize={9.5} fill={INK} fontWeight={i === 0 ? 700 : 400}>
            {v}
          </text>
        </g>
      ))}
      {cols.map(([k, v], i) => (
        <g key={k} transform={`translate(${leftW + (i * (W - leftW)) / 2} ${H * 0.75})`}>
          {i > 0 && <line x1={0} y1={0} x2={0} y2={H / 4} stroke={INK} strokeWidth={0.5} />}
          <text x={6} y={8.5} fontSize={5.5} fill="#64748b" fontWeight={600}>
            {k}
          </text>
          <text x={6} y={19} fontSize={9.5} fill={INK}>
            {v}
          </text>
        </g>
      ))}
      {selected && (
        <rect
          data-noexport
          x={-3}
          y={-3}
          width={W + 6}
          height={H + 6}
          fill="none"
          stroke="#0ea5e9"
          strokeWidth={1.2}
          strokeDasharray="4 3"
        />
      )}
    </g>
  )
}

/** Legend — auto-generated from the symbols and duct styles actually used. */
export function LegendG({ doc, selected }: { doc: Doc; selected: boolean }) {
  const used = new Set(doc.blocks.map((b) => b.symbolId))
  const syms = CATEGORIES.flatMap((c) => SYMBOLS.filter((s) => s.category === c && used.has(s.id)))
  const ductRows: { label: string; cls: 'supply' | 'return'; kind: 'rigid' | 'flex' }[] = []
  for (const cls of ['supply', 'return'] as const) {
    for (const kind of ['rigid', 'flex'] as const) {
      if (doc.ducts.some((d) => d.cls === cls && d.kind === kind)) {
        ductRows.push({ label: `${cls === 'supply' ? 'Supply' : 'Return'} — ${kind}`, cls, kind })
      }
    }
  }
  const ROW = 16
  const W = 168
  const H = 24 + (syms.length + ductRows.length) * ROW + 6
  const l = doc.legend
  return (
    <g data-id="legend" transform={`translate(${l.x} ${l.y})`} style={{ cursor: 'move' }}>
      <rect width={W} height={H} fill="#fff" stroke={INK} strokeWidth={1.2} />
      <text x={8} y={15} fontSize={9} fontWeight={800} fill={INK} letterSpacing={1}>
        LEGEND
      </text>
      <line x1={0} y1={21} x2={W} y2={21} stroke={INK} strokeWidth={0.6} />
      {ductRows.map((r, i) => {
        const y = 24 + i * ROW + ROW / 2
        const color = r.cls === 'supply' ? SUPPLY : RETURN
        return (
          <g key={r.label}>
            <line
              x1={8}
              y1={y}
              x2={34}
              y2={y}
              stroke={color}
              strokeWidth={r.kind === 'rigid' ? 4 : 3}
              strokeDasharray={r.kind === 'flex' ? '4 2.5' : undefined}
              strokeLinecap="round"
            />
            <text x={42} y={y + 2.5} fontSize={7.5} fill={INK}>
              {r.label}
            </text>
          </g>
        )
      })}
      {syms.map((s, i) => {
        const y = 24 + (ductRows.length + i) * ROW + ROW / 2
        const k = 11 / Math.max(s.w, s.h)
        return (
          <g key={s.id}>
            <g transform={`translate(21 ${y}) scale(${k})`}>{s.render()}</g>
            <text x={42} y={y + 2.5} fontSize={7.5} fill={INK}>
              {s.name}
            </text>
          </g>
        )
      })}
      {selected && (
        <rect
          data-noexport
          x={-3}
          y={-3}
          width={W + 6}
          height={H + 6}
          fill="none"
          stroke="#0ea5e9"
          strokeWidth={1.2}
          strokeDasharray="4 3"
        />
      )}
    </g>
  )
}
