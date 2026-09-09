# Duct Layout Designer

A purpose-built duct layout drawing app for residential HVAC work — a replacement
for sketching systems in Lucidchart. Single-technician, no login, no backend:
everything runs in the browser and saves locally.

## Run it

```bash
npm install
npm run dev      # development
npm run build    # production build in dist/ (static, host anywhere)
```

## What it does

**Canvas** — large scrollable canvas with a light grid (6″ / 12″ / 24″ per square),
snap-to-grid toggle, pan (drag empty space, two-finger drag, spacebar drag, or the
Pan tool), pinch and scroll-wheel zoom from 25–400 %, undo/redo (100 steps).

**Equipment palette** — schematic symbols for furnaces (upflow / downflow /
horizontal), condenser, heat pump, cased evap coil, supply/return plenums, return
air drop, floor and ceiling supply registers (with throw arrows), return grilles,
balancing dampers, flex connections, thermostat, and a resizable custom box.
Tap a symbol then tap the canvas to place (touch-friendly), or drag-and-drop.
Every block has editable label, model/tonnage, 90° rotation, and notes.

**Duct drawing** — click a connection port (or anywhere), click waypoints,
double-click / Enter / ✓ to finish. Right-angle routing by default with a freehand
toggle. Ducts snap to equipment ports and to other duct runs — clicking mid-run
starts a takeoff branch. Supply renders orange, return blue; rigid metal is a solid
double line, flex is dashed. Each run carries size (round Ø or rectangular W×H),
CFM capacity, and material, with labels rendered along the line.

**CFM tally** — select a trunk to see total downstream register CFM vs. the trunk's
labeled capacity. Over-capacity trunks flag red on the canvas and in the panel.

**Rooms** — rectangle tool or polygon wall tool, faint fill, name label,
auto-calculated square footage (overridable), optional target CFM.

**Underlay** — import a floor plan photo or PDF page, scale it with the corner
handle, set opacity, and lock it; then draw on top.

**Title block & legend** — permit-style title block (job, customer, address, date,
drawn by, company) and an auto-generated legend of whatever symbols/duct types the
drawing uses. Both draggable.

**Files** — autosave to localStorage on every change; recent-jobs list;
duplicate-job to reuse a layout as a template; save/load `.json` layout files;
export high-res PNG (full drawing or current view) and PDF (letter or 11×17).

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| V / D / R / W / H | Select / Duct / Room / Walls / Pan |
| Ctrl+Z, Ctrl+Shift+Z | Undo, redo |
| Delete | Remove selection |
| Enter / Esc | Finish / cancel the run being drawn |
| Space-drag | Pan |
| + / − | Zoom |

## Adding equipment

All symbols live in `src/symbols/palette.tsx`. Add an entry to `SYMBOLS` (size in
inches, connection ports, and an SVG `render`) and it automatically appears in the
sidebar palette, the legend, and hit-testing/snapping.
