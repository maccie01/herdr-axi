---
figure: 02-phase-capacity.png
mode: readme
anchor: 02-boundary-clamp.png
character: 01-packet-bot-sheet.png
language: en
---

**QA:** Final PNG inspected in color and grayscale; glyphs and line styles retain meaning without hue. README embedding checked locally at desktop and mobile widths; enlarge images for small-screen labels.

**Caption:** Explicit phases bound concurrency: explore 4, build 3, integrate 2, verify 2, fix 1 by default. Tasks advance when their own dependencies are accepted; phase changes never kill active work. Project policy supplies roles, models, effort and separate native-reviewer limits.

**Source:** Original; herdr-axi README and implementation at 6688fee. Built-in image generation; not a runtime screenshot.

**Deviations from anchor:** A descending left-to-right capacity stair instead of a central vertical crossing; task-slot rails rather than source/sink boxes; Packet Bot adjusts a phase selector at upper-right.

**Three-second read:** Broad exploration narrows into focused fixes without forcing every task through a batch barrier.

**Prompt:**

```text
Generate one standalone 16:9 landscape technical fieldnote figure, 2048x1152 if available, intended for an English GitHub README. Use case: infographic-diagram. NEW composition, not an edit of the attached references.
Visual DNA: white background, thin black analyst-notebook sketch strokes with subtle natural wobble, restrained technical line art, abundant whitespace (at least 30%), legible large handwritten English labels. Flat diagram, no decorative heading, no gradient, no dense text, no corporate cards, no shields, locks, people or cyber imagery.
Readme character: exactly ONE small Packet Bot matching reference 1: horizontal rounded packet body, tiny header ticks, checksum corner notch, minimal screen face, modular connector tool arms, no hands or legs. It performs the specified verification/control action. All system boxes are faceless, without header ticks or checksum notches. Reference 2 is the locked quality/composition anchor (02-boundary-clamp), not a layout template. Any further image is a previously accepted figure for set consistency only.
Encoding: ordinary relations thin black arrows. Risk is a red solid arrow. Controls are BLUE GATE/CLAMP/LATCH GLYPHS directly on a path, never a blue connection or blue alternative route. Ownership/trust boundary is AMBER DASHED. Residual caveat AMBER DOTTED with an open gap, never solid. Verified pass uses a small GREEN CHECK TAG, only after a real control. Meaning must survive grayscale. No distinction by color alone.
Constraints: one mechanism only, 3–7 short labels, each 1–4 words; render ONLY the requested labels verbatim, no other copy or tiny pseudo-text. Keep all labels readable when displayed 800px wide. Every mark must explain a relationship. Keep corner and edge margins generous. Do not copy either reference's layout. No system-as-mascot. No claim of full sandbox security or autonomous billing changes.

Core three-second read: Broad exploration narrows into focused fixes without forcing every task through a batch barrier.
Mechanism: explicitly bounded phased concurrency. Structure: failure chain with control points, interpreted as scheduling gates. One connected stepped series of FIVE open slot trays descends gently from left to right, with exactly 4,3,2,2,1 small task-slot rectangles in them. Show the 4-slot first tray widest, the final 1-slot tray narrowest; keep all five legible. Place short phase labels immediately above their corresponding trays. A thin black arrow connects each adjacent tray; blue small gate glyphs sit directly on those arrows to express deliberate phase changes, not an automatic conveyor. Above the trays a small policy card connects to a mechanical selector whose probe is adjusted by the SINGLE Packet Bot at upper-right. Beneath the middle tray, a tiny accepted check-tag opens one dependency gate to one next task; neighboring waiting task stays held, no all-worker barrier. Labels ONLY: "explore · 4", "build · 3", "integrate · 2", "verify · 2", "fix · 1", "Explicit phase", "Project policy". No automatic maturity gauge. Trays represent limits, not forcibly killed workers.
Anchor invariants: same thin wobbling stroke, restraint, whitespace, sparse labels, identical small functional Packet Bot. Three mandatory deviations: A descending left-to-right capacity stair instead of a central vertical crossing; task-slot rails rather than source/sink boxes; Packet Bot adjusts a phase selector at upper-right.
```
