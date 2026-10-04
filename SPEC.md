# NyxX – Website Specification

## Overview
Personal consulting website for **NyxX (Andreas Doukas s.p.)**, a sole-proprietor EM & thermal simulation consulting business based in Slovenia.

**Owner:** Dr. Andreas Doukas  
**Domain (target):** nyxx-sim.com  
**Hosting:** GitHub Pages (static site, no backend)  
**Stack:** Plain HTML + CSS + minimal vanilla JS — no frameworks, no build tools

---

## Brand

### Identity
- Company name: **NyxX**
- Full legal name: NyxX (Andreas Doukas s.p.)
- Owner: Dr. Andreas Doukas

### Color palette
| Token | Hex | Usage |
|---|---|---|
| `--navy` | `#0d0d2e` | Primary text, CTA background |
| `--indigo` | `#3f51b5` / `#5c6bc0` | Accents, nav links, borders |
| `--cyan` | `#1565c0` / `#4fc3f7` | Highlights, hover states |
| `--muted` | `#9fa8da` | Secondary text, labels |
| `--bg` | `#ffffff` | Page background |
| `--surface` | `#f8f9ff` | Card backgrounds |
| `--border` | `#e0e4f0` | Card borders, dividers |

### Typography
- **Headings:** Georgia, serif — font-weight 400 (not bold)
- **Body/UI:** Arial, sans-serif
- **Nav links:** sentence case, letter-spacing: 1.5px
- **Labels/eyebrows:** small caps style, letter-spacing: 3px, color: muted
- **No ALL CAPS for body text** — only for short labels (e.g. "HFSS", "TOOLS")

### Logo
- Symbol-only SVG: `assets/logo-crescent.svg` (44×44, no text)
- Crescent arc: indigo double-stroke (`#3f51b5`), cyan inner edge (`#1565c0`), star at tip (`#1a237e`)
- Nav wordmark rendered in HTML, not SVG: `Nyx` in `#0d0d2e` navy, `X` in `#3f51b5` indigo
- Dark variant SVG: `assets/logo-nav-dark.svg` (for email signatures, dark backgrounds)

```html
<!-- Nav logo — correct implementation -->
<a class="nav-logo" href="#">
  <img src="assets/logo-crescent.svg" height="38" alt="NyxX">
  <span class="nav-wordmark">Nyx<em>X</em></span>
</a>
```
```css
.nav-wordmark { font-family: Georgia, serif; font-size: 24px; font-weight: 400; color: #0d0d2e; letter-spacing: 0.5px; }
.nav-wordmark em { color: #3f51b5; font-style: normal; }
```

---

## Site structure

Single-page layout with smooth scroll to anchor sections. No separate pages needed initially.

```
index.html
assets/
  logo-dark.svg
  logo-light.svg
  favicon.svg
style.css
```

### Sections (in order)

1. **Nav** — fixed top, logo left, links right
2. **Hero** — headline + name + subtext + CTA + stat cards
3. **Services** — 5 service cards
4. **Case Studies** — 3 anonymized project cards
5. **About** — brief bio
6. **Contact** — simple mailto form or Formspree

---

## Section specs

### 1. Nav
- Fixed, white background, `border-bottom: 0.5px solid #e0e4f0`
- Left: NyxX logo (SVG)
- Right: Services · Case studies · About · Contact
- Active link: `color: #0d0d2e`, `border-bottom: 1px solid #0d0d2e`
- No hamburger menu needed initially (add later if needed)

### 2. Hero
- Two-column layout: left = text, right = stat cards
- **Eyebrow:** "Electromagnetic · Thermal · RF simulation"
- **H1:** "High-fidelity simulation for hardware that matters" — "hardware that matters" in `--cyan`
- **Byline:** "Dr. Andreas Doukas" — indigo, left border accent, NOT all caps
- **Subtext:** "Independent Ansys consulting for power electronics, EM machines, PCB integrity, and thermal management. PhD-level expertise, startup-friendly engagement."
- **CTA button:** "Request a consultation" — dark navy, no border-radius > 4px
- **Note below CTA:** "Typical response within 24 hours · Slovenia, EU"
- **Stat cards (right column):**
  - Tools: Maxwell · HFSS / Icepak · SIwave
  - Experience: 8+ years in EM & thermal simulation
  - Background: PhD Theoretical Physics, JSI
- **Tools bar (bottom of hero):** "POWERED BY" label + badges: Ansys Electronics Desktop · COMSOL · PyAEDT · Python

### 3. Services
- **Eyebrow:** "What I do"
- **H2:** "Simulation services across the full EM & thermal stack"
- 5 cards in a row (CSS grid, `repeat(5, 1fr)`)
- Each card: icon (colored square), service name, tool badge, 1-line description

| Service | Tool | Color |
|---|---|---|
| RF & Microwave Design | HFSS | indigo `#3f51b5` |
| PCB Signal & Power Integrity | SIwave | green `#2e7d32` |
| Thermal Management | Icepak | amber `#e65100` |
| EM Machines | Maxwell | purple `#7b1fa2` |
| EMC / EMI Analysis | HFSS · Maxwell | cyan `#1565c0` |

### 4. Case Studies
- **Eyebrow:** "Selected work"
- **H2:** "Results from past engagements"
- Background: `--surface` (`#fafbff`)
- 3 cards in a row
- Each card: colored tag (service), project title, 2-line description, metric (large serif number), metric label

| Project | Metric |
|---|---|
| Power converter thermal optimization (EV drivetrain) | −18°C max junction temp |
| PMSM loss analysis, high-speed industrial spindle | +3.2% efficiency |
| PDN optimization, high-speed digital board | −34 dB impedance peak |

> **Note:** All case studies are anonymized — no client names.

### 5. About
- Short paragraph: PhD in theoretical physics (Jožef Stefan Institute), prior R&D at GEM motors, now Lead Development Engineer + independent consultant
- Mention: Ansys Electronics Desktop expertise (Maxwell, HFSS, Icepak, SIwave), Python/PyAEDT automation
- Keep it concise — 3-4 sentences max, no life story

### 6. Contact
- **Headline:** "Get in touch"
- **Subtext:** "Describe your project briefly — I'll respond within 24 hours with an assessment."
- Use [Formspree](https://formspree.io) for form handling (free tier, no backend needed)
- Fields: Name, Email, Subject (dropdown: RF/Microwave, PCB, Thermal, EM Machines, EMC, Other), Message
- Submit button: same style as hero CTA

---

## Design principles
- Generous white space — don't fill every pixel
- No animations except subtle hover transitions (`transition: 0.15s ease`)
- No stock photos or illustrations — the mockup aesthetic is the aesthetic
- Mobile: single column, nav collapses to hamburger (can be phase 2)
- Performance: no external JS libraries, Google Fonts optional (Georgia is system font)

---

## Writing tone (case studies and site copy)
- Measured, professional and informative: full sentences that say what was done and why it is useful.
- No blunt one-word openers or verdicts ("None.", "Speed only.", "No ML needed."), no slang ("a real trap") and no jokey asides.
- "Role of ML" box: lead with what ML contributes. Where a study uses no ML, describe the direct physics approach and explain why it suits the study, without framing ML as a mistake.
- "Physics" box: a scannable list of short items (bold label plus a one-line detail, `ul.phys-list`), not a run-on paragraph. Each detail names the actual method and what it captures (e.g. "Coupled thermal network that feeds magnet temperature back into the remanence"), never a restatement of the label ("Thermal network").
- State limits plainly under "Stated limits", in the same calm tone.

---

## Claude Code instructions

When building this site:
1. Start with `index.html` + `style.css` as two files
2. Use CSS custom properties (variables) for all colors and spacing
3. Each section gets its own CSS comment block
4. No inline styles except where unavoidable
5. Semantic HTML: `<nav>`, `<section>`, `<article>`, `<footer>`
6. Add `id` anchors to each section matching the nav links
7. Test that the CTA button and contact form are functional before considering done
