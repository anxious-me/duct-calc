import { useState } from 'react'
import type { DuctClass, DuctKind, GridIn, Tool } from '../types'
import type { JobMeta } from '../state/store'

export interface MenuActions {
  newJob: () => void
  openFile: () => void
  saveFile: () => void
  duplicate: () => void
  importUnderlay: () => void
  exportPngAll: () => void
  exportPngView: () => void
  exportPdf: (paper: 'letter' | 'tabloid') => void
  jobs: JobMeta[]
  openJob: (id: string) => void
  toggleTitle: () => void
  toggleLegend: () => void
}

interface Props {
  tool: Tool
  setTool: (t: Tool) => void
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
  snap: boolean
  setSnap: (v: boolean) => void
  ortho: boolean
  setOrtho: (v: boolean) => void
  showGrid: boolean
  setShowGrid: (v: boolean) => void
  gridIn: GridIn
  setGridIn: (g: GridIn) => void
  ductCls: DuctClass
  setDuctCls: (c: DuctClass) => void
  ductKind: DuctKind
  setDuctKind: (k: DuctKind) => void
  zoomPct: number
  zoomIn: () => void
  zoomOut: () => void
  fit: () => void
  paletteOpen: boolean
  togglePalette: () => void
  actions: MenuActions
}

const TOOLS: { id: Tool; label: string; key: string; icon: string }[] = [
  { id: 'select', label: 'Select', key: 'V', icon: '➤' },
  { id: 'duct', label: 'Duct', key: 'D', icon: '⊥' },
  { id: 'room', label: 'Room', key: 'R', icon: '▭' },
  { id: 'polyroom', label: 'Walls', key: 'W', icon: '⬠' },
  { id: 'pan', label: 'Pan', key: 'H', icon: '✋' },
]

export function Toolbar(p: Props) {
  const [menu, setMenu] = useState(false)
  const [jobsOpen, setJobsOpen] = useState(false)
  const act = (fn: () => void) => () => {
    setMenu(false)
    setJobsOpen(false)
    fn()
  }
  return (
    <div className="toolbar">
      <button className="tb-btn" onClick={() => setMenu(!menu)} title="File menu">
        ☰
      </button>
      {menu && (
        <>
          <div className="menu-backdrop" onClick={() => setMenu(false)} />
          <div className="menu">
            <button onClick={act(p.actions.newJob)}>New job</button>
            <button onClick={act(p.actions.duplicate)}>Duplicate job (use as template)</button>
            <button onClick={() => setJobsOpen(!jobsOpen)}>Recent jobs ▸</button>
            {jobsOpen &&
              p.actions.jobs.slice(0, 8).map((j) => (
                <button key={j.id} className="menu-sub" onClick={act(() => p.actions.openJob(j.id))}>
                  {j.name}
                </button>
              ))}
            <hr />
            <button onClick={act(p.actions.openFile)}>Open layout file (JSON)…</button>
            <button onClick={act(p.actions.saveFile)}>Save layout file (JSON)</button>
            <hr />
            <button onClick={act(p.actions.importUnderlay)}>Import floor plan underlay…</button>
            <button onClick={act(p.actions.toggleTitle)}>Show / hide title block</button>
            <button onClick={act(p.actions.toggleLegend)}>Show / hide legend</button>
            <hr />
            <button onClick={act(p.actions.exportPngAll)}>Export PNG — full drawing</button>
            <button onClick={act(p.actions.exportPngView)}>Export PNG — current view</button>
            <button onClick={act(() => p.actions.exportPdf('letter'))}>Export PDF — letter</button>
            <button onClick={act(() => p.actions.exportPdf('tabloid'))}>Export PDF — 11×17</button>
          </div>
        </>
      )}

      <button className="tb-btn" onClick={p.togglePalette} title="Toggle equipment palette">
        {p.paletteOpen ? '◀' : '▶'} <span className="tb-label">Palette</span>
      </button>

      <span className="tb-sep" />
      <button className="tb-btn" disabled={!p.canUndo} onClick={p.undo} title="Undo (Ctrl+Z)">
        ↶
      </button>
      <button className="tb-btn" disabled={!p.canRedo} onClick={p.redo} title="Redo (Ctrl+Shift+Z)">
        ↷
      </button>

      <span className="tb-sep" />
      {TOOLS.map((t) => (
        <button
          key={t.id}
          className={`tb-btn ${p.tool === t.id ? 'tb-active' : ''}`}
          onClick={() => p.setTool(t.id)}
          title={`${t.label} (${t.key})`}
        >
          <span className="tb-icon">{t.icon}</span>
          <span className="tb-label">{t.label}</span>
        </button>
      ))}

      {p.tool === 'duct' && (
        <>
          <span className="tb-sep" />
          <button
            className={`tb-btn tb-chip ${p.ductCls === 'supply' ? 'chip-supply' : ''}`}
            onClick={() => p.setDuctCls('supply')}
          >
            Supply
          </button>
          <button
            className={`tb-btn tb-chip ${p.ductCls === 'return' ? 'chip-return' : ''}`}
            onClick={() => p.setDuctCls('return')}
          >
            Return
          </button>
          <button
            className={`tb-btn ${p.ductKind === 'rigid' ? 'tb-active' : ''}`}
            onClick={() => p.setDuctKind('rigid')}
            title="Rigid metal — solid double line"
          >
            Rigid
          </button>
          <button
            className={`tb-btn ${p.ductKind === 'flex' ? 'tb-active' : ''}`}
            onClick={() => p.setDuctKind('flex')}
            title="Flex — dashed line"
          >
            Flex
          </button>
          <button
            className={`tb-btn ${p.ortho ? 'tb-active' : ''}`}
            onClick={() => p.setOrtho(!p.ortho)}
            title="Right-angle routing (toggle for freehand)"
          >
            ∟
          </button>
        </>
      )}

      <span className="tb-sep" />
      <select
        className="tb-select"
        value={p.gridIn}
        onChange={(e) => p.setGridIn(Number(e.target.value) as GridIn)}
        title="Grid square size"
      >
        <option value={6}>6″ grid</option>
        <option value={12}>12″ grid</option>
        <option value={24}>24″ grid</option>
      </select>
      <button
        className={`tb-btn ${p.snap ? 'tb-active' : ''}`}
        onClick={() => p.setSnap(!p.snap)}
        title="Snap to grid"
      >
        ⌗
      </button>
      <button
        className={`tb-btn ${p.showGrid ? 'tb-active' : ''}`}
        onClick={() => p.setShowGrid(!p.showGrid)}
        title="Show grid"
      >
        ▦
      </button>

      <span className="tb-sep" />
      <button className="tb-btn" onClick={p.zoomOut} title="Zoom out">
        −
      </button>
      <span className="tb-zoom">{p.zoomPct}%</span>
      <button className="tb-btn" onClick={p.zoomIn} title="Zoom in">
        +
      </button>
      <button className="tb-btn" onClick={p.fit} title="Fit drawing">
        ⤢
      </button>
    </div>
  )
}
