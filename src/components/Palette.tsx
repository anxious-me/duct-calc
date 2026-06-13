import { CATEGORIES, SYMBOLS, type SymbolDef } from '../symbols/palette'

function SymbolThumb({ sym }: { sym: SymbolDef }) {
  const pad = 3
  return (
    <svg
      className="pal-thumb"
      viewBox={`${-sym.w / 2 - pad} ${-sym.h / 2 - pad} ${sym.w + 2 * pad} ${sym.h + 2 * pad}`}
    >
      {sym.render()}
    </svg>
  )
}

export function Palette({
  open,
  pending,
  onPick,
}: {
  open: boolean
  pending: string | null
  onPick: (id: string | null) => void
}) {
  return (
    <div className={`palette ${open ? '' : 'palette-closed'}`}>
      <div className="pal-hint">Tap a symbol, then tap the canvas to place it. Drag works too.</div>
      {CATEGORIES.map((cat) => (
        <div key={cat}>
          <div className="pal-cat">{cat}</div>
          <div className="pal-grid">
            {SYMBOLS.filter((s) => s.category === cat).map((s) => (
              <button
                key={s.id}
                className={`pal-item ${pending === s.id ? 'pal-active' : ''}`}
                title={s.name}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/x-symbol', s.id)
                  e.dataTransfer.effectAllowed = 'copy'
                }}
                onClick={() => onPick(pending === s.id ? null : s.id)}
              >
                <SymbolThumb sym={s} />
                <span>{s.name}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
