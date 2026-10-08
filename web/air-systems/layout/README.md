# air.systems layout: one centered column, header fit, commercial header photo

Website work for air.systems, parked here so it is version controlled. Nothing in
this folder ships with the duct layout app.

Site: https://www.air.systems (WordPress, Kadence theme)

## Install

Paste all of `svc-layout.css` at the very bottom of Appearance, Customize,
Additional CSS, then publish. Nothing to upload: the commercial header photo is
already in the media library.

• Part 1, header, every page
• Part 2, the Commercial HVAC San Jose page only (`body.page-id-12770`)
• Part 3, every other page and every blog post, tablet width and up, plus one phone
  fix for the city pages

Each part is self contained, so any one of them can be deleted on its own to undo it.

## What was wrong

Sections stepped in and out down every page. Colored bands ran wall to wall, cards
sat at 1152px, text sat at 1152px or 820px or 852px, and a few widgets sat at 880px
or 720px. Measured at 1440 wide before the fix:

| Page type | Section edges from the screen edge |
| --- | --- |
| Commercial HVAC | 0, 270 and 294px |
| Home | 0 for the bands, 144 for the cards inside them, 340 for headings |
| City hubs (Sunnyvale, Fremont and the rest) | 0, 120, 144 and 280px |
| City service pages (AC, furnace, heat pump in each city) | 0 for the bands, 310 for the text |
| Service and brand pages | 0, 94, 120, 140 and 144px |
| Blog posts | title at 24px, featured image at 0, article card at 94 |

On top of that:

• The header row is capped at 1240px but logo, eight menu items and the call, text
  and schedule buttons need about 1380px. The buttons overflowed their row by 184px
  on every page: 62px of sideways scroll and a cut off Schedule Service button at
  1440, 302px at 1100, 378px at 1024, and 162px off center at 1920.
• On phones the city service pages ran 24px past the right edge of the screen, which
  cut the last word off most lines.
• On the commercial page Kadence's `.single-content h1` margin beat the hero's own,
  leaving a 102px dead gap above the headline.

## What the CSS does

Part 1, header: the row widens to 1340px with tighter menu padding. Under 1361px the
header Text button folds away (Text Us is in the top strip already). Under 1241px the
menu button and slide-out take over, the same ones phones already use.

Part 2, commercial page: every section held at the 852px the text already used, the
proof section turned into a card with a two by two grid, and the hero rebuilt with the
rooftop condenser and downtown San Jose skyline photo
(`2024/04/20180827_095444-scaled.webp`) in a 4:3 band that fades into the dark behind
the text.

Part 3, everything else:

• The content area itself becomes the column: 1152px, which is the site's 1200px rail
  minus its 24px gutters. City service pages are long reads held at 820px, so their
  column is 900px.
• Every way a section was breaking out to the screen edge is switched off inside the
  column: `.alignfull`, `.alignwide`, inline `100vw` and `50vw` styles, and the
  `.band`, `.heroA`, `.svc-xo`, `.svcc` (coupons) and `.svch` (water heater) sections.
• Colored bands become rounded cards with a 16px gap, so neighbours read as cards
  instead of one slab. On the home page the hero and its stats strip stay one card.
• Cards inside a white band line up with the column edge. Colored bands get 24 to 40px
  of inner padding.
• The weather widget (880px) and the featured reviews (720px) fill the column, the
  reviews as two cards side by side.
• Blog posts: title, featured image and article card share the card's edges, and the
  post text sits 50px inside the card instead of touching its edges.
• Phones: Part 3 leaves phones alone except the city page sections, which now sit
  inside the screen with a 20px inner gutter.

## Verified

The CSS was injected into the live pages in Chromium, and every measurement waited
until all of the site's own stylesheets had loaded.

Section edges after the fix, measured from the screen edge at 1440 wide:

| Page type | Before | After |
| --- | --- | --- |
| Commercial HVAC | 0, 270 and 294px | all 74 sections at 294 |
| Home | 0, 144 and 168px | all 20 boxes at 144 |
| City hubs | 0, 120, 144 and 280px | all at 144, reviews two across |
| City service pages | 0 and 310px | all at 270 (900px column) |
| AC repairs, service pages | 0, 144 and 280px | all boxes at 144 |
| Commissioning pages | 0 and 144px | all at 144 |
| Water heater, gallery, Williams, crossover, coupons | 0 | all at 144 |
| Blog posts | title 24, image 0, card 94 | title, image and card at 94, text at 144 |

Sideways scroll went to 0 on every page checked. Tablet at 1024: home, city hub and
city service pages each sit on one edge pair, and the header shows the menu button.
Phones at 390 are unchanged except the city service pages, which went from running
24px off the right edge to one centered column.

Header checked on the commercial page, the home page and the Sunnyvale city page at
1100 to 1536: no sideways scroll, buttons inside the row, slide-out opens with links on
screen and closes.

Hero text contrast on the commercial page, measured against the brightest 5% of the
photo behind each line: eyebrow 5.3:1 desktop and 6.0:1 phone, headline 13.1:1 and
15.3:1, intro 11.0:1 and 11.1:1. All pass WCAG AA.

## Found, not changed

• Commercial page: right under the stats bar the page repeats the full hero intro
  paragraph, then has eight stray one line paragraphs (Call 408-691-5940, Text a photo
  of the data plate, Commercial HVAC San Jose owner operated, $199 Commercial
  diagnostic, $299 Nights weekends holidays, Same day, 25 years, Commercial HVAC San
  Jose for Small Buildings). That is content, so delete those nine blocks in the
  editor rather than hiding them with CSS.
• The full-bleed CSS on the `claude/home-page-padding-layout-luj42b` branch (PR #2)
  pushes background sections to the screen edge, which is the opposite of this. It was
  never deployed. Don't ship it on top of this.
