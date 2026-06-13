import { useCallback, useEffect, useRef, useState } from 'react'
import { newDoc, todayStr, uid, type Doc } from '../types'

const HISTORY_LIMIT = 100
const LS_JOBS = 'ductcalc:jobs'
const LS_CURRENT = 'ductcalc:current'
const LS_DOC = (id: string) => `ductcalc:doc:${id}`

export interface JobMeta {
  id: string
  name: string
  savedAt: number
}

export function listJobs(): JobMeta[] {
  try {
    const jobs = JSON.parse(localStorage.getItem(LS_JOBS) ?? '[]') as JobMeta[]
    return jobs.sort((a, b) => b.savedAt - a.savedAt)
  } catch {
    return []
  }
}

function writeJobs(jobs: JobMeta[]) {
  localStorage.setItem(LS_JOBS, JSON.stringify(jobs))
}

export function saveJob(id: string, doc: Doc) {
  try {
    localStorage.setItem(LS_DOC(id), JSON.stringify(doc))
    localStorage.setItem(LS_CURRENT, id)
    const jobs = listJobs().filter((j) => j.id !== id)
    jobs.push({ id, name: doc.title.jobName || 'Untitled', savedAt: Date.now() })
    writeJobs(jobs)
  } catch {
    // localStorage full or unavailable — autosave silently degrades
  }
}

export function loadJob(id: string): Doc | null {
  try {
    const raw = localStorage.getItem(LS_DOC(id))
    if (!raw) return null
    return { ...newDoc(), ...(JSON.parse(raw) as Doc) }
  } catch {
    return null
  }
}

export function deleteJob(id: string) {
  localStorage.removeItem(LS_DOC(id))
  writeJobs(listJobs().filter((j) => j.id !== id))
}

export function loadInitial(): { id: string; doc: Doc } {
  const cur = localStorage.getItem(LS_CURRENT)
  if (cur) {
    const doc = loadJob(cur)
    if (doc) return { id: cur, doc }
  }
  return { id: uid('job'), doc: newDoc() }
}

export interface DocStore {
  doc: Doc
  jobId: string
  /** Commit a change as an undoable step. */
  commit: (next: Doc) => void
  /** Update without pushing history (e.g. mid-drag); call commit at gesture end. */
  preview: (next: Doc) => void
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
  newJob: () => void
  openJob: (id: string) => void
  openDoc: (doc: Doc) => void
  duplicateJob: () => void
}

export function useDocStore(): DocStore {
  const [initial] = useState(loadInitial)
  const [jobId, setJobId] = useState(initial.id)
  const [doc, setDoc] = useState<Doc>(initial.doc)
  const [flags, setFlags] = useState({ canUndo: false, canRedo: false })

  // History lives in refs and is mutated only inside event handlers, never
  // during render or inside setState updaters (StrictMode double-invokes those).
  const live = useRef(initial.doc) // latest doc, including previews
  const past = useRef<Doc[]>([])
  const future = useRef<Doc[]>([])
  // Base state for the current preview gesture (history pushes from here).
  const previewBase = useRef<Doc | null>(null)

  const syncFlags = () =>
    setFlags({ canUndo: past.current.length > 0, canRedo: future.current.length > 0 })

  const commit = useCallback((next: Doc) => {
    const base = previewBase.current ?? live.current
    previewBase.current = null
    if (next !== base) {
      past.current.push(base)
      if (past.current.length > HISTORY_LIMIT) past.current.shift()
      future.current = []
    }
    live.current = next
    setDoc(next)
    syncFlags()
  }, [])

  const preview = useCallback((next: Doc) => {
    if (!previewBase.current) previewBase.current = live.current
    live.current = next
    setDoc(next)
  }, [])

  const undo = useCallback(() => {
    const prev = past.current.pop()
    if (!prev) return
    future.current.push(previewBase.current ?? live.current)
    previewBase.current = null
    live.current = prev
    setDoc(prev)
    syncFlags()
  }, [])

  const redo = useCallback(() => {
    const next = future.current.pop()
    if (!next) return
    past.current.push(live.current)
    previewBase.current = null
    live.current = next
    setDoc(next)
    syncFlags()
  }, [])

  const resetTo = useCallback((id: string, d: Doc) => {
    past.current = []
    future.current = []
    previewBase.current = null
    live.current = d
    setJobId(id)
    setDoc(d)
    saveJob(id, d)
    syncFlags()
  }, [])

  const newJob = useCallback(() => resetTo(uid('job'), newDoc()), [resetTo])

  const openJob = useCallback(
    (id: string) => {
      const d = loadJob(id)
      if (d) resetTo(id, d)
    },
    [resetTo],
  )

  const openDoc = useCallback((d: Doc) => resetTo(uid('job'), d), [resetTo])

  const duplicateJob = useCallback(() => {
    const cur = live.current
    const copy: Doc = {
      ...cur,
      title: { ...cur.title, jobName: `${cur.title.jobName} copy`, date: todayStr() },
    }
    resetTo(uid('job'), copy)
  }, [resetTo])

  // Debounced autosave so a refresh never loses work.
  useEffect(() => {
    const t = setTimeout(() => saveJob(jobId, doc), 600)
    return () => clearTimeout(t)
  }, [doc, jobId])

  return {
    doc,
    jobId,
    commit,
    preview,
    undo,
    redo,
    canUndo: flags.canUndo,
    canRedo: flags.canRedo,
    newJob,
    openJob,
    openDoc,
    duplicateJob,
  }
}
