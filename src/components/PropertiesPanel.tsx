import type { Doc, DuctClass, DuctKind, Rot, Selection } from '../types'
import { SYMBOL_MAP } from '../symbols/palette'
import { polygonArea } from '../utils/geometry'
import type { Tally } from '../utils/connectivity'

interface Props {
  doc: Doc
  sel: Selection
  preview: (d: Doc) => void
  commit: (d: Doc) => void
  onDelete: () => void
  tally: Tally | null
}

const CFM_SYMBOLS = new Set(['register-floor', 'register-ceiling', 'return-grille'])

function num(v: string): number | null {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : null
}

export function PropertiesPanel({ doc, sel, preview, commit, onDelete, tally }: Props) {
  if (!sel) return null

  // Text inputs preview while typing and commit one undo step on blur.
  const blurCommit = () => commit(doc)

  let body: React.ReactNode = null
  let heading = ''

  if (sel.type === 'block') {
    const b = doc.blocks.find((x) => x.id === sel.id)
    if (!b) return null
    const sym = SYMBOL_MAP[b.symbolId]
    heading = sym.name
    const up = (patch: Partial<typeof b>, instant = false) => {
      const next = { ...doc, blocks: doc.blocks.map((x) => (x.id === b.id ? { ...x, ...patch } : x)) }
      if (instant) commit(next)
      else preview(next)
    }
    body = (
      <>
        <label>
          Label
          <input value={b.label} onChange={(e) => up({ label: e.target.value })} onBlur={blurCommit} />
        </label>
        <label>
          Model / tonnage
          <input value={b.model} onChange={(e) => up({ model: e.target.value })} onBlur={blurCommit} />
        </label>
        {CFM_SYMBOLS.has(b.symbolId) && (
          <label>
            CFM
            <input
              type="number"
              value={b.cfm ?? ''}
              onChange={(e) => up({ cfm: num(e.target.value) })}
              onBlur={blurCommit}
            />
          </label>
        )}
        {b.symbolId === 'custom' && (
          <div className="row2">
            <label>
              Width (in)
              <input
                type="number"
                value={b.w ?? sym.w}
                onChange={(e) => up({ w: num(e.target.value) ?? sym.w })}
                onBlur={blurCommit}
              />
            </label>
            <label>
              Height (in)
              <input
                type="number"
                value={b.h ?? sym.h}
                onChange={(e) => up({ h: num(e.target.value) ?? sym.h })}
                onBlur={blurCommit}
              />
            </label>
          </div>
        )}
        <div className="row2">
          <button onClick={() => up({ rot: ((b.rot + 270) % 360) as Rot }, true)}>⟲ Rotate</button>
          <button onClick={() => up({ rot: ((b.rot + 90) % 360) as Rot }, true)}>⟳ Rotate</button>
        </div>
        <label>
          Notes
          <textarea
            rows={2}
            value={b.notes}
            onChange={(e) => up({ notes: e.target.value })}
            onBlur={blurCommit}
          />
        </label>
      </>
    )
  } else if (sel.type === 'duct') {
    const d = doc.ducts.find((x) => x.id === sel.id)
    if (!d) return null
    heading = `${d.cls === 'supply' ? 'Supply' : 'Return'} duct`
    const up = (patch: Partial<typeof d>, instant = false) => {
      const next = { ...doc, ducts: doc.ducts.map((x) => (x.id === d.id ? { ...x, ...patch } : x)) }
      if (instant) commit(next)
      else preview(next)
    }
    body = (
      <>
        <div className="row2">
          <label>
            Class
            <select value={d.cls} onChange={(e) => up({ cls: e.target.value as DuctClass }, true)}>
              <option value="supply">Supply (orange)</option>
              <option value="return">Return (blue)</option>
            </select>
          </label>
          <label>
            Type
            <select value={d.kind} onChange={(e) => up({ kind: e.target.value as DuctKind }, true)}>
              <option value="rigid">Rigid metal</option>
              <option value="flex">Flex</option>
            </select>
          </label>
        </div>
        <div className="row2">
          <label>
            Shape
            <select
              value={d.size.shape}
              onChange={(e) =>
                up(
                  {
                    size:
                      e.target.value === 'round'
                        ? { shape: 'round', d: d.size.shape === 'rect' ? d.size.h : 8 }
                        : { shape: 'rect', w: 12, h: d.size.shape === 'round' ? d.size.d : 8 },
                  },
                  true,
                )
              }
            >
              <option value="round">Round</option>
              <option value="rect">Rectangular</option>
            </select>
          </label>
          {d.size.shape === 'round' ? (
            <label>
              Diameter (in)
              <input
                type="number"
                value={d.size.d}
                onChange={(e) => up({ size: { shape: 'round', d: num(e.target.value) ?? 8 } })}
                onBlur={blurCommit}
              />
            </label>
          ) : (
            (() => {
              const rect = d.size
              return (
                <div className="row2">
                  <label>
                    W
                    <input
                      type="number"
                      value={rect.w}
                      onChange={(e) =>
                        up({ size: { shape: 'rect', w: num(e.target.value) ?? 12, h: rect.h } })
                      }
                      onBlur={blurCommit}
                    />
                  </label>
                  <label>
                    H
                    <input
                      type="number"
                      value={rect.h}
                      onChange={(e) =>
                        up({ size: { shape: 'rect', w: rect.w, h: num(e.target.value) ?? 8 } })
                      }
                      onBlur={blurCommit}
                    />
                  </label>
                </div>
              )
            })()
          )}
        </div>
        <div className="row2">
          <label>
            CFM capacity
            <input
              type="number"
              value={d.cfm ?? ''}
              onChange={(e) => up({ cfm: num(e.target.value) })}
              onBlur={blurCommit}
            />
          </label>
          <label>
            Material
            <input
              value={d.material}
              onChange={(e) => up({ material: e.target.value })}
              onBlur={blurCommit}
            />
          </label>
        </div>
        {tally && (
          <div className={`tally ${tally.over ? 'tally-over' : ''}`}>
            Downstream: <b>{tally.downstreamCfm} CFM</b> across {tally.registerCount} register
            {tally.registerCount === 1 ? '' : 's'}
            {tally.capacity != null && (
              <>
                {' '}
                vs capacity <b>{tally.capacity} CFM</b>
                {tally.over ? ' — OVER' : ' ✓'}
              </>
            )}
          </div>
        )}
      </>
    )
  } else if (sel.type === 'room') {
    const r = doc.rooms.find((x) => x.id === sel.id)
    if (!r) return null
    heading = 'Room'
    const autoSqft = Math.round(polygonArea(r.points) / 144)
    const up = (patch: Partial<typeof r>) =>
      preview({ ...doc, rooms: doc.rooms.map((x) => (x.id === r.id ? { ...x, ...patch } : x)) })
    body = (
      <>
        <label>
          Name
          <input value={r.name} onChange={(e) => up({ name: e.target.value })} onBlur={blurCommit} />
        </label>
        <div className="row2">
          <label>
            Sq ft (auto {autoSqft})
            <input
              type="number"
              placeholder={String(autoSqft)}
              value={r.sqftOverride ?? ''}
              onChange={(e) => up({ sqftOverride: num(e.target.value) })}
              onBlur={blurCommit}
            />
          </label>
          <label>
            Target CFM
            <input
              type="number"
              value={r.targetCfm ?? ''}
              onChange={(e) => up({ targetCfm: num(e.target.value) })}
              onBlur={blurCommit}
            />
          </label>
        </div>
      </>
    )
  } else if (sel.type === 'underlay') {
    const u = doc.underlay
    if (!u) return null
    heading = 'Floor plan underlay'
    body = (
      <>
        <label>
          Opacity
          <input
            type="range"
            min={0.1}
            max={1}
            step={0.05}
            value={u.opacity}
            onChange={(e) =>
              preview({ ...doc, underlay: { ...u, opacity: parseFloat(e.target.value) } })
            }
            onMouseUp={blurCommit}
            onTouchEnd={blurCommit}
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={u.locked}
            onChange={(e) => commit({ ...doc, underlay: { ...u, locked: e.target.checked } })}
          />
          Lock (clicks pass through)
        </label>
        <div className="hint">Drag to position, drag the corner handle to scale it to your grid.</div>
      </>
    )
  } else if (sel.type === 'title') {
    const t = doc.title
    heading = 'Title block'
    const up = (patch: Partial<typeof t>) => preview({ ...doc, title: { ...t, ...patch } })
    const field = (key: keyof typeof t, label: string) => (
      <label>
        {label}
        <input
          value={String(t[key])}
          onChange={(e) => up({ [key]: e.target.value })}
          onBlur={blurCommit}
        />
      </label>
    )
    body = (
      <>
        {field('jobName', 'Job name')}
        {field('customer', 'Customer')}
        {field('address', 'Address')}
        <div className="row2">
          {field('date', 'Date')}
          {field('drawnBy', 'Drawn by')}
        </div>
        {field('company', 'Company')}
        <div className="row2">
          {field('phone', 'Phone')}
          {field('web', 'Web')}
        </div>
      </>
    )
  } else if (sel.type === 'legend') {
    heading = 'Legend'
    body = <div className="hint">Auto-generated from the symbols and duct types in the drawing. Drag to reposition.</div>
  }

  const deletable = sel.type === 'block' || sel.type === 'duct' || sel.type === 'room' || sel.type === 'underlay'

  return (
    <div className="props">
      <div className="props-head">
        <span>{heading}</span>
        {deletable && (
          <button className="danger" onClick={onDelete} title="Delete (Del)">
            Delete
          </button>
        )}
      </div>
      <div className="props-body">{body}</div>
    </div>
  )
}
