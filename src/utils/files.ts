import { jsPDF } from 'jspdf'
import type { Doc, Underlay } from '../types'
import { SYMBOL_MAP, SYMBOLS } from '../symbols/palette'
import { newDoc } from '../types'

/** Rendered size of the auto-generated legend box, in inches. */
export function legendSize(doc: Doc): { w: number; h: number } {
  const used = new Set(doc.blocks.map((b) => b.symbolId))
  const symCount = SYMBOLS.filter((s) => used.has(s.id)).length
  let ductCount = 0
  for (const cls of ['supply', 'return'] as const) {
    for (const kind of ['rigid', 'flex'] as const) {
      if (doc.ducts.some((d) => d.cls === cls && d.kind === kind)) ductCount++
    }
  }
  return { w: 168, h: 24 + (symCount + ductCount) * 16 + 6 }
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

export function safeName(s: string): string {
  return (s || 'duct-layout').replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-')
}

export function saveDocJson(doc: Doc) {
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' })
  downloadBlob(blob, `${safeName(doc.title.jobName)}.json`)
}

export function parseDocJson(text: string): Doc {
  const raw = JSON.parse(text) as Partial<Doc>
  if (!Array.isArray(raw.blocks) || !Array.isArray(raw.ducts)) {
    throw new Error('Not a duct layout file')
  }
  const base = newDoc()
  return {
    ...base,
    ...raw,
    title: { ...base.title, ...raw.title },
    legend: { ...base.legend, ...raw.legend },
  } as Doc
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.onchange = () => resolve(input.files?.[0] ?? null)
    // 'cancel' fires on modern browsers when the dialog is dismissed
    input.oncancel = () => resolve(null)
    input.click()
  })
}

async function pdfPageToDataUrl(file: File): Promise<{ src: string; w: number; h: number }> {
  const pdfjs = await import('pdfjs-dist')
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
  const data = await file.arrayBuffer()
  const pdf = await pdfjs.getDocument({ data }).promise
  const page = await pdf.getPage(1)
  const viewport = page.getViewport({ scale: 2 })
  const canvas = document.createElement('canvas')
  canvas.width = viewport.width
  canvas.height = viewport.height
  const ctx = canvas.getContext('2d')!
  await page.render({ canvas, canvasContext: ctx, viewport }).promise
  return { src: canvas.toDataURL('image/png'), w: viewport.width, h: viewport.height }
}

function imageToDataUrl(file: File): Promise<{ src: string; w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => resolve({ src: reader.result as string, w: img.width, h: img.height })
      img.onerror = reject
      img.src = reader.result as string
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

/** Import a floor plan image or PDF page as an underlay, default 50 ft wide. */
export async function importUnderlay(file: File, center: { x: number; y: number }): Promise<Underlay> {
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
  const { src, w, h } = isPdf ? await pdfPageToDataUrl(file) : await imageToDataUrl(file)
  const wIn = 600
  const hIn = (wIn * h) / w
  return {
    src,
    x: center.x - wIn / 2,
    y: center.y - hIn / 2,
    w: wIn,
    h: hIn,
    opacity: 0.45,
    locked: false,
  }
}

export interface Bbox {
  x: number
  y: number
  w: number
  h: number
}

/** Bounding box of all drawing content, in inches. */
export function contentBbox(doc: Doc): Bbox {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const grow = (x: number, y: number) => {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  for (const b of doc.blocks) {
    const sym = SYMBOL_MAP[b.symbolId]
    const r = Math.max(b.w ?? sym.w, b.h ?? sym.h) / 2 + 8
    grow(b.x - r, b.y - r)
    grow(b.x + r, b.y + r)
  }
  for (const d of doc.ducts) {
    for (const p of d.points) {
      grow(p.x - 10, p.y - 10)
      grow(p.x + 10, p.y + 10)
    }
  }
  for (const r of doc.rooms) for (const p of r.points) grow(p.x, p.y)
  if (doc.underlay) {
    grow(doc.underlay.x, doc.underlay.y)
    grow(doc.underlay.x + doc.underlay.w, doc.underlay.y + doc.underlay.h)
  }
  if (doc.title.visible) {
    grow(doc.title.x, doc.title.y)
    grow(doc.title.x + 300, doc.title.y + 96)
  }
  if (doc.legend.visible) {
    const ls = legendSize(doc)
    grow(doc.legend.x, doc.legend.y)
    grow(doc.legend.x + ls.w, doc.legend.y + ls.h)
  }
  if (minX === Infinity) return { x: 0, y: 0, w: 400, h: 300 }
  const m = 24
  return { x: minX - m, y: minY - m, w: maxX - minX + 2 * m, h: maxY - minY + 2 * m }
}

/** Render the drawing SVG to a high-res PNG canvas. */
async function renderToCanvas(svgEl: SVGSVGElement, bbox: Bbox): Promise<HTMLCanvasElement> {
  const clone = svgEl.cloneNode(true) as SVGSVGElement
  // strip transient UI (selection handles, snap highlights, grid)
  clone.querySelectorAll('[data-noexport]').forEach((el) => el.remove())
  // undo the pan/zoom transform on the content group
  clone.querySelector('[data-world]')?.removeAttribute('transform')

  const scale = Math.min(4, 8000 / Math.max(bbox.w, bbox.h))
  const pxW = Math.round(bbox.w * scale)
  const pxH = Math.round(bbox.h * scale)
  clone.setAttribute('viewBox', `${bbox.x} ${bbox.y} ${bbox.w} ${bbox.h}`)
  clone.setAttribute('width', String(pxW))
  clone.setAttribute('height', String(pxH))
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')

  const svgText = new XMLSerializer().serializeToString(clone)
  const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }))
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = () => reject(new Error('SVG rasterize failed'))
      i.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = pxW
    canvas.height = pxH
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, pxW, pxH)
    ctx.drawImage(img, 0, 0, pxW, pxH)
    return canvas
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function exportPng(svgEl: SVGSVGElement, bbox: Bbox, name: string) {
  const canvas = await renderToCanvas(svgEl, bbox)
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'))
  if (blob) downloadBlob(blob, `${safeName(name)}.png`)
}

export async function exportPdf(
  svgEl: SVGSVGElement,
  bbox: Bbox,
  name: string,
  paper: 'letter' | 'tabloid',
) {
  const canvas = await renderToCanvas(svgEl, bbox)
  const size: [number, number] = paper === 'letter' ? [8.5, 11] : [11, 17]
  const landscape = bbox.w >= bbox.h
  const pageW = landscape ? size[1] : size[0]
  const pageH = landscape ? size[0] : size[1]
  const pdf = new jsPDF({
    orientation: landscape ? 'landscape' : 'portrait',
    unit: 'in',
    format: paper === 'letter' ? 'letter' : [11, 17],
  })
  const margin = 0.35
  const availW = pageW - 2 * margin
  const availH = pageH - 2 * margin
  const s = Math.min(availW / bbox.w, availH / bbox.h)
  const w = bbox.w * s
  const h = bbox.h * s
  pdf.addImage(
    canvas.toDataURL('image/jpeg', 0.92),
    'JPEG',
    (pageW - w) / 2,
    (pageH - h) / 2,
    w,
    h,
  )
  pdf.save(`${safeName(name)}.pdf`)
}
