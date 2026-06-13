import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DuctClass, DuctKind, GridIn, Selection, Tool } from './types'
import { useDocStore, listJobs } from './state/store'
import { CanvasView, type CanvasHandle } from './components/CanvasView'
import { Palette } from './components/Palette'
import { Toolbar } from './components/Toolbar'
import { PropertiesPanel } from './components/PropertiesPanel'
import { computeTally } from './utils/connectivity'
import { SYMBOL_MAP } from './symbols/palette'
import {
  contentBbox,
  exportPdf,
  exportPng,
  importUnderlay,
  parseDocJson,
  pickFile,
  saveDocJson,
} from './utils/files'

export default function App() {
  const store = useDocStore()
  const { doc, commit, preview } = store

  const [tool, setToolRaw] = useState<Tool>('select')
  const [sel, setSel] = useState<Selection>(null)
  const [snap, setSnap] = useState(true)
  const [ortho, setOrtho] = useState(true)
  const [showGrid, setShowGrid] = useState(true)
  const [ductCls, setDuctCls] = useState<DuctClass>('supply')
  const [ductKind, setDuctKind] = useState<DuctKind>('rigid')
  const [pendingSymbol, setPendingSymbol] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(window.innerWidth > 760)
  const [zoomPct, setZoomPct] = useState(100)
  const [spaceDown, setSpaceDown] = useState(false)
  const [drafting, setDrafting] = useState(false)

  const canvas = useRef<CanvasHandle>(null)

  const setTool = useCallback((t: Tool) => {
    canvas.current?.cancelDraft()
    setPendingSymbol(null)
    setToolRaw(t)
  }, [])

  const pickSymbol = useCallback((id: string | null) => {
    canvas.current?.cancelDraft()
    setToolRaw('select')
    setPendingSymbol(id)
    if (id && window.innerWidth <= 760) setPaletteOpen(false)
  }, [])

  useEffect(() => {
    document.title = `${doc.title.jobName} — Duct Layout`
  }, [doc.title.jobName])

  // when a saved job is restored on launch, bring its content into view
  useEffect(() => {
    if (doc.blocks.length || doc.ducts.length || doc.rooms.length) {
      canvas.current?.fitContent()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const deleteSel = useCallback(() => {
    if (!sel) return
    if (sel.type === 'block') commit({ ...doc, blocks: doc.blocks.filter((b) => b.id !== sel.id) })
    else if (sel.type === 'duct') commit({ ...doc, ducts: doc.ducts.filter((d) => d.id !== sel.id) })
    else if (sel.type === 'room') commit({ ...doc, rooms: doc.rooms.filter((r) => r.id !== sel.id) })
    else if (sel.type === 'underlay') commit({ ...doc, underlay: null })
    else return
    setSel(null)
  }, [sel, doc, commit])

  // keyboard shortcuts
  useEffect(() => {
    const isTyping = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      return (
        t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable
      )
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e)) return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) store.redo()
        else store.undo()
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        store.redo()
        return
      }
      if (e.ctrlKey || e.metaKey) return
      switch (e.key) {
        case 'v':
        case 'V':
          setTool('select')
          break
        case 'd':
        case 'D':
          setTool('duct')
          break
        case 'r':
        case 'R':
          setTool('room')
          break
        case 'w':
        case 'W':
          setTool('polyroom')
          break
        case 'h':
        case 'H':
          setTool('pan')
          break
        case 'Delete':
        case 'Backspace':
          deleteSel()
          break
        case 'Enter':
          canvas.current?.finishDraft()
          break
        case 'Escape':
          if (canvas.current?.isDrafting()) canvas.current.cancelDraft()
          else if (pendingSymbol) setPendingSymbol(null)
          else setSel(null)
          break
        case ' ':
          e.preventDefault()
          setSpaceDown(true)
          break
        case '+':
        case '=':
          canvas.current?.zoomBy(1.2)
          break
        case '-':
          canvas.current?.zoomBy(1 / 1.2)
          break
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') setSpaceDown(false)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [store, setTool, deleteSel, pendingSymbol])

  const tally = useMemo(() => (sel?.type === 'duct' ? computeTally(doc, sel.id) : null), [doc, sel])

  const doImportUnderlay = async () => {
    const f = await pickFile('image/*,.pdf,application/pdf')
    if (!f) return
    try {
      const u = await importUnderlay(f, canvas.current?.centerWorld() ?? { x: 300, y: 200 })
      commit({ ...doc, underlay: u })
      setSel({ type: 'underlay' })
    } catch {
      alert('Could not read that file. Use a PNG/JPG image or a PDF.')
    }
  }

  const doOpenFile = async () => {
    const f = await pickFile('.json,application/json')
    if (!f) return
    try {
      store.openDoc(parseDocJson(await f.text()))
      setSel(null)
      setTimeout(() => canvas.current?.fitContent(), 50)
    } catch {
      alert('That file is not a valid duct layout.')
    }
  }

  const doExportPng = (view: boolean) => {
    const svg = canvas.current?.svg()
    if (!svg) return
    const bb = view ? canvas.current!.viewBbox() : contentBbox(doc)
    void exportPng(svg, bb, doc.title.jobName)
  }

  const doExportPdf = (paper: 'letter' | 'tabloid') => {
    const svg = canvas.current?.svg()
    if (!svg) return
    void exportPdf(svg, contentBbox(doc), doc.title.jobName, paper)
  }

  return (
    <div className="app">
      <Toolbar
        tool={tool}
        setTool={setTool}
        undo={store.undo}
        redo={store.redo}
        canUndo={store.canUndo}
        canRedo={store.canRedo}
        snap={snap}
        setSnap={setSnap}
        ortho={ortho}
        setOrtho={setOrtho}
        showGrid={showGrid}
        setShowGrid={setShowGrid}
        gridIn={doc.gridIn}
        setGridIn={(g: GridIn) => commit({ ...doc, gridIn: g })}
        ductCls={ductCls}
        setDuctCls={setDuctCls}
        ductKind={ductKind}
        setDuctKind={setDuctKind}
        zoomPct={zoomPct}
        zoomIn={() => canvas.current?.zoomBy(1.2)}
        zoomOut={() => canvas.current?.zoomBy(1 / 1.2)}
        fit={() => canvas.current?.fitContent()}
        paletteOpen={paletteOpen}
        togglePalette={() => setPaletteOpen(!paletteOpen)}
        actions={{
          newJob: () => {
            store.newJob()
            setSel(null)
          },
          duplicate: () => {
            store.duplicateJob()
            setSel({ type: 'title' })
          },
          jobs: listJobs().filter((j) => j.id !== store.jobId),
          openJob: (id) => {
            store.openJob(id)
            setSel(null)
            setTimeout(() => canvas.current?.fitContent(), 50)
          },
          openFile: doOpenFile,
          saveFile: () => saveDocJson(doc),
          importUnderlay: doImportUnderlay,
          exportPngAll: () => doExportPng(false),
          exportPngView: () => doExportPng(true),
          exportPdf: doExportPdf,
          toggleTitle: () => commit({ ...doc, title: { ...doc.title, visible: !doc.title.visible } }),
          toggleLegend: () => commit({ ...doc, legend: { ...doc.legend, visible: !doc.legend.visible } }),
        }}
      />
      <div className="main">
        <Palette open={paletteOpen} pending={pendingSymbol} onPick={pickSymbol} />
        <CanvasView
          ref={canvas}
          doc={doc}
          commit={commit}
          preview={preview}
          tool={tool}
          sel={sel}
          setSel={setSel}
          snap={snap}
          ortho={ortho}
          showGrid={showGrid}
          ductCls={ductCls}
          ductKind={ductKind}
          pendingSymbol={pendingSymbol}
          spaceDown={spaceDown}
          onZoomChange={setZoomPct}
          onDrafting={setDrafting}
        />
        <PropertiesPanel
          doc={doc}
          sel={sel}
          preview={preview}
          commit={commit}
          onDelete={deleteSel}
          tally={tally}
        />
        {drafting && (
          <div className="draft-bar">
            <button className="primary" onClick={() => canvas.current?.finishDraft()}>
              ✓ Finish
            </button>
            <button onClick={() => canvas.current?.cancelDraft()}>✕ Cancel</button>
          </div>
        )}
        {pendingSymbol && !drafting && (
          <div className="draft-bar">
            <span className="placing">Placing: {SYMBOL_MAP[pendingSymbol].name}</span>
            <button onClick={() => setPendingSymbol(null)}>✕ Done</button>
          </div>
        )}
      </div>
    </div>
  )
}
