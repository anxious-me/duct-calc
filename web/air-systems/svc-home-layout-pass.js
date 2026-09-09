/* Silicon Valley Comfort home page layout pass
   Run in the browser console with the home page open in the WordPress block editor.
   Step 1 audits and changes nothing. Step 2 applies. Step 3 saves.
   Undo works normally in the editor, so a bad result is one Ctrl+Z away. */

/* ---------- STEP 1, AUDIT. Run this alone first. ---------- */
(() => {
  const S = wp.data.select('core/block-editor');
  const rows = S.getBlocks().map((b, i) => {
    const a = b.attributes || {};
    const bg =
      a.style?.color?.background ||
      a.backgroundColor ||
      (a.style?.background?.backgroundImage ? 'image' : null) ||
      a.bgColor ||
      null;
    const p = a.style?.spacing?.padding || {};
    return {
      idx: i,
      block: b.name,
      align: a.align || 'none',
      innerLayout: a.layout?.type || 'none',
      background: bg || 'none',
      padTop: p.top || '-',
      padSide: p.left || '-',
      fullBleed: a.align === 'full' ? 'yes' : 'NO',
    };
  });
  console.table(rows);
  const broken = rows.filter((r) => r.background !== 'none' && r.fullBleed === 'NO');
  console.log(
    broken.length
      ? broken.length + ' sections carry a background but are not full bleed. Those are your white trim.'
      : 'Every background section is already full bleed. The trim is coming from the theme layout setting instead.'
  );
  return rows;
})();

/* ---------- STEP 2, APPLY. Run after the audit looks right. ---------- */
(() => {
  const S = wp.data.select('core/block-editor');
  const D = wp.data.dispatch('core/block-editor');
  const SECTION = 'clamp(3rem, 7vw, 5.5rem)';
  const GUTTER = 'clamp(1.15rem, 5vw, 2.5rem)';
  const GROUPS = ['core/group', 'core/cover', 'core/columns'];
  let bled = 0;
  let contained = 0;

  S.getBlocks().forEach((b) => {
    if (!GROUPS.includes(b.name)) return;
    const a = b.attributes || {};
    const hasBg = !!(
      a.style?.color?.background ||
      a.backgroundColor ||
      a.style?.background?.backgroundImage ||
      b.name === 'core/cover'
    );

    const next = {
      style: {
        ...(a.style || {}),
        spacing: {
          ...(a.style?.spacing || {}),
          padding: { top: SECTION, bottom: SECTION, left: GUTTER, right: GUTTER },
        },
      },
    };

    /* background sections span the viewport */
    if (hasBg && a.align !== 'full') {
      next.align = 'full';
      bled++;
    }

    /* their content stays in the centered container */
    if (b.name !== 'core/columns') {
      next.layout = { ...(a.layout || {}), type: 'constrained' };
      contained++;
    }

    D.updateBlockAttributes(b.clientId, next);
  });

  console.log(bled + ' sections pushed to full bleed, ' + contained + ' set to constrained content.');
  console.log('Look at the canvas. If it reads right, run step 3.');
})();

/* ---------- STEP 3, SAVE. ---------- */
wp.data.dispatch('core/editor').savePost();

/* ---------- STEP 4, VERIFY on the live page with a cache buster. ---------- */
/*
(() => {
  const doc = document;
  const body = doc.body.getBoundingClientRect();
  const bad = Array.from(doc.querySelectorAll('.alignfull, .has-background')).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.left > 2 || r.right < body.width - 2;
  });
  console.log(bad.length ? 'Still inset, check these:' : 'All background sections reach both edges.', bad);
  console.log('Sideways scroll:', doc.documentElement.scrollWidth > doc.documentElement.clientWidth ? 'YES, fix it' : 'none');
})();
*/
