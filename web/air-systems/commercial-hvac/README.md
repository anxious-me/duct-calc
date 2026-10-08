# Commercial HVAC San Jose page: one column, header photo, header fit

Website work for air.systems, parked here so it is version controlled. Nothing in
this folder ships with the duct layout app.

Page: https://www.air.systems/commercial-hvac-san-jose/ (WordPress page id 12770, Kadence theme)

## Install

Paste all of `svc-commercial-column.css` at the very bottom of
Appearance, Customize, Additional CSS, then publish. Nothing to upload: the header
photo is already in the media library.

Part 1 (header) applies to every page. Part 2 (column and photo) is scoped to
`body.page-id-12770` and cannot touch any other page.

## What was wrong

• The page's own style block holds headings, paragraphs and lists at 900px, but the
  custom sections (hero, stats bar, price table, steps, dark callout, Related, the
  proof section and Check it yourself) had no width rule. The page is set to full
  width in Kadence, so those ran edge to edge. Down the page the content width went
  900, 1440, 900, 1440, 900, 1388, 1440, 1200, 1440 at a 1440 screen.
• Kadence pads the content wrapper 0 on desktop, 32px under 1024 and 24px under 767,
  while the text added its own 24px on top, so text and cards drifted apart on
  tablets and phones.
• The header row is capped at 1240px but logo, eight menu items and the call, text
  and schedule buttons need about 1380px. The buttons overflowed their row by 184px
  at every width: 62px of sideways scroll and a cut off Schedule Service button at
  1440, 302px of sideways scroll at 1100, and 162px off center at 1920.
• Kadence's `.single-content h1` margin (1.5em) beat the hero's `.svcc-h1` margin,
  leaving a 102px dead gap above the headline.

## What the CSS does

• Every direct child of the content area gets the same max width (852px, the visible
  text width it already had) and centers. Text loses its private padding so its edge
  is the column edge. The theme wrapper padding is zeroed and the column owns a 24px
  gutter instead.
• The proof section, which forces itself full width with inline styles, becomes a
  rounded card in the column, and its four cards go two by two instead of three plus
  an orphan.
• Header: row widened to 1340px with tighter menu padding. Under 1361px the header
  Text button folds away (Text Us is in the top strip already). Under 1241px the menu
  button and slide-out take over, the same ones phones already use.
• Hero: the rooftop condenser photo with the downtown San Jose skyline and water tower
  (`2024/04/20180827_095444-scaled.webp`) fills a 4:3 band across the top of the hero
  card and fades into the dark where the text sits. Text starts under the skyline at
  every width because both the band height and the text offset follow the card width.

## Verified

Injected into the live page in Chromium with every stylesheet confirmed loaded.

| Screen | Before | After |
| --- | --- | --- |
| 1920 | sections at 0, 510 and 534px from the edge | all 74 sections at 534 |
| 1440 | sections at 0, 270 and 294, 62px sideways scroll | all at 294, no scroll |
| 1366 | | all at 257, no scroll |
| 1280 | 142px sideways scroll | all at 214, no scroll |
| 1024 | | all at 86, no scroll, menu button |
| 390 phone | text at 48, cards at 24 | all at 24 |

Header checked on this page, the home page and the Sunnyvale city page at 1100 to
1536: no sideways scroll, buttons inside the row, slide-out opens with links on screen
and closes.

Hero text contrast, measured against the brightest 5% of the backdrop behind each
line: eyebrow 5.3:1 desktop and 6.0:1 phone, headline 13.1:1 and 15.3:1, intro 11.0:1
and 11.1:1. All pass WCAG AA.

## Found, not changed

• Right under the stats bar the page repeats the full hero intro paragraph, then has
  eight stray one line paragraphs: Call 408-691-5940, Text a photo of the data plate,
  Commercial HVAC San Jose owner operated, $199 Commercial diagnostic, $299 Nights
  weekends holidays, Same day, 25 years, Commercial HVAC San Jose for Small Buildings.
  That is content, so delete those nine blocks in the editor rather than hiding them
  with CSS.
• The `web/air-systems` full-bleed CSS on the `claude/home-page-padding-layout-luj42b`
  branch pushes background sections to the screen edge, which is the opposite of this
  fix. It was never deployed. Don't ship it on top of this.
