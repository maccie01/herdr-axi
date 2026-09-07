---
figure: 04-worktree-isolation.png
mode: readme
anchor: 02-boundary-clamp.png
character: 01-packet-bot-sheet.png
language: en
---

**QA:** Final PNG inspected in color and grayscale; glyphs and line styles retain meaning without hue. README embedding checked locally at desktop and mobile widths; enlarge images for small-screen labels.

**Caption:** Parallel writers need separate canonical worktrees. A second writer waits even with a different --area; readers also reserve their worktree by default. Optional same-run shared readers and native reviewers are instruction-bound, not OS isolation; final verification follows accepted writes.

**Source:** Original; herdr-axi README and implementation at 6688fee. Built-in image generation; not a runtime screenshot.

**Deviations from anchor:** Two diagonal worktree bays with a visible collision at lower-left rather than email-to-service; physical reservation tabs are central; Packet Bot sits within the spacing between bays checking the reservation.

**Three-second read:** Parallel work is safe only when writer reservations do not overlap.

**Prompt:**

```text
Generate one standalone 16:9 landscape technical fieldnote figure, 2048x1152 if available, intended for an English GitHub README. Use case: infographic-diagram. NEW composition, not an edit of the attached references.
Visual DNA: white background, thin black analyst-notebook sketch strokes with subtle natural wobble, restrained technical line art, abundant whitespace (at least 30%), legible large handwritten English labels. Flat diagram, no decorative heading, no gradient, no dense text, no corporate cards, no shields, locks, people or cyber imagery.
Readme character: exactly ONE small Packet Bot matching reference 1: horizontal rounded packet body, tiny header ticks, checksum corner notch, minimal screen face, modular connector tool arms, no hands or legs. It performs the specified verification/control action. All system boxes are faceless, without header ticks or checksum notches. Reference 2 is the locked quality/composition anchor (02-boundary-clamp), not a layout template. Any further image is a previously accepted figure for set consistency only.
Encoding: ordinary relations thin black arrows. Risk is a red solid arrow. Controls are BLUE GATE/CLAMP/LATCH GLYPHS directly on a path, never a blue connection or blue alternative route. Ownership/trust boundary is AMBER DASHED. Residual caveat AMBER DOTTED with an open gap, never solid. Verified pass uses a small GREEN CHECK TAG, only after a real control. Meaning must survive grayscale. No distinction by color alone.
Constraints: one mechanism only, 3–7 short labels, each 1–4 words; render ONLY the requested labels verbatim, no other copy or tiny pseudo-text. Keep all labels readable when displayed 800px wide. Every mark must explain a relationship. Keep corner and edge margins generous. Do not copy either reference's layout. No system-as-mascot. No claim of full sandbox security or autonomous billing changes.

Core three-second read: Parallel work is safe only when writer reservations do not overlap.
Mechanism: worktree writer exclusion. Structure: coverage asymmetry. Two separate broad shallow repository trays arranged diagonally, worktree A lower-left and worktree B upper-right, each containing simple files and exactly one worker terminal attached by a short thin black arrow through a BLUE reservation gate. No faces on terminals. One extra writer terminal at far left attempts to connect to occupied tray A via RED solid arrow visibly stopped at the same gate; its alternate permitted thin BLACK route turns below both trays toward B's vacant reservation slot—but to avoid suggesting B supports two writers, instead draw B with only that extra writer as its sole assigned worker, and make the attempted path originate from that same B worker. Thus exactly two writers total; first owns A, second owns B, second's attempted cross-write to A blocked. Tiny read-only magnifier held over tray A on an AMBER DOTTED tether depicts optional observation, no write arrow; a visible gap in its dotted outline means not a sandbox. SINGLE Packet Bot between trays measures A's reservation with a probe. Labels ONLY: "Writer A", "Worktree A", "Writer B", "Worktree B", "Reservation", "Optional read sharing", "Not a sandbox".
Anchor invariants: same thin wobbling stroke, restraint, whitespace, sparse labels, identical small functional Packet Bot. Three mandatory deviations: Two diagonal worktree bays with a visible collision at lower-left rather than email-to-service; physical reservation tabs are central; Packet Bot sits within the spacing between bays checking the reservation.
```

**Targeted edit:**

```text
Simplify this image to show TWO INDEPENDENT writer/worktree pairs, with no cross-worktree connections. Delete the ENTIRE red path and red X. Delete the ENTIRE long black bent line connecting the RIGHT edge of Worktree A to the reservation gate beside Worktree B. Keep Writer A -> its blue reservation gate -> Worktree A; keep Writer B -> its own blue reservation gate -> Worktree B. These two pairs must be completely disconnected. Keep the single Packet Bot's dotted probing line, the Optional read sharing magnifier and its amber dotted tether, all labels and all other objects in place. Do not add any new objects or arrows. White background where deleted paths were. Same 16:9 hand-drawn style.
```

Final simplification: independent writer/worktree pairs, no cross-write path. Collision behavior explained in caption; six rendered labels, reservation expressed by gate glyphs.
