# air.systems layout fix

Full-bleed section backgrounds with the content held in one centered container.
Nothing in this folder ships with the duct layout app. It is website work, parked
here so it is version controlled instead of living in a chat scroll.

## The problem

Colored sections stopped short of the viewport edge, leaving white trim down both
sides, and the text sat almost against the edge of its own background color. Two
separate causes stacked on top of each other:

• The theme wraps page content in a boxed shell, a white card with its own max width
  and padding. Every section inside it inherits that width, so a background color can
  never reach the edge of the screen.
• The sections carry only a few pixels of inner padding, so the copy crowds the color.

## The fix

`svc-home-fullbleed.css` goes in Appearance, Customize, Additional CSS. It is global,
so every page falls in line with the home page. Seven rules, in order:

0. Unboxes the theme content shell. In Kadence this is Content Style set to Boxed,
   and flipping that setting in the Customizer does the same job without any CSS.
1. Full-bleed sections span the viewport, using negative margins rather than `100vw`
   so a scrollbar cannot cause sideways scroll.
2. Content inside those sections stops at `--svc-container` and centers.
3. One vertical rhythm for every section instead of per-block guesses.
4. Colored blocks get real side padding so text is never against the edge.
5. A full-bleed section nested inside another one does not double its inset.
6. Phones tighten the vertical spacing and columns stack.

Three variables carry the whole system, so spacing changes in one place:

```css
--svc-container: 1200px;
--svc-gutter: clamp(1.15rem, 5vw, 2.5rem);
--svc-section: clamp(3rem, 7vw, 5.5rem);
```

`svc-home-layout-pass.js` is the block-level half, run from the browser console with
the page open in the WordPress editor. Step 1 audits and changes nothing. Step 2 sets
`align: full` on every top level group that carries a background and switches its inner
layout to constrained. Step 3 saves. Step 4 verifies on the live page. Editor undo
works normally, so a bad pass is one keystroke away.

## Seeing it before it goes live

Open `preview.html` in a browser. It imitates a theme in boxed mode and reproduces the
bug. The button in the corner toggles the fix on and off.

## Measured on that preview at 1440 wide

| | fix off | fix on |
| --- | --- | --- |
| section gap each side | 150px | 0 |
| section width | 1140 | 1440 |
| text padding | 9.6px | 19 to 40px, scales with viewport |
| sideways scroll on a 390 wide phone | yes | no |
