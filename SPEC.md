# sim.adoukas.eu – Website Specification

## Overview
Consulting website of **Andreas Doukas s.p.** (Dr. Andreas Doukas), independent EM, thermal and CFD simulation consulting, based in Ljubljana, Slovenia.

**Domain:** https://sim.adoukas.eu (`CNAME`)  
**Repo:** andreasdk1/adoukas-sim, local folder `~/Documents/Engineering/adoukas-sim`  
**Hosting:** GitHub Pages from `main` (static, no backend)  
**Stack:** plain HTML + CSS + vanilla JS; no frameworks, no build step

---

## Brand
- Name shown on the site: **Andreas Doukas** with the AD monogram (inline SVG in the nav and footer)
- Legal name (footer, privacy notice): Andreas Doukas s.p. · Slovenia, EU
- Colours, type and spacing are CSS custom properties in `:root` of `style.css` (ink/paper neutrals, brand blues from the monogram, dark "night" sections)
- Fonts: Newsreader (headings), Inter (body), JetBrains Mono (code/numbers), Montserrat (brand); self-hosted in `assets/fonts/fonts.css`. Never link Google Fonts.

---

## Site structure

```
index.html            home: hero, services, approach, case studies, about, contact
demo.html             interactive demo (demo.css, js/demo.js)
cases/*.html          one page per case study (shared cases/case.css)
privacy.html          privacy notice
style.css             site-wide styles
js/site.js            nav and page behaviour
js/field.js           hero background
js/consent.js         analytics consent banner + Google Analytics loader
js/cocktail.js        martini player on cases/cocktail.html
assets/               images, fonts, case media (assets/cases/<case>/)
sitemap.xml, robots.txt
```

### Case studies
Each case page corresponds to a project repo in `~/Documents/Engineering/cases/`:

| Page | Project folder |
|---|---|
| `cases/pmsm-outrunner.html` | `pmsm_outrunner` |
| `cases/cispr25-explorer.html` | `cispr25_explorer` |
| `cases/meander-antenna.html` | `meander_antenna` |
| `cases/rogowski-sensor.html` | `sensor_surrogate_demo` |
| `cases/ct-tamper.html` | `ct_tamper_surrogate_demo` |
| `cases/cocktail.html` | `cocktail_sim` |

New case: add the page under `cases/`, a card in the case-studies section of `index.html`, and an entry in `sitemap.xml`.

### Contact
Form posts to Formspree (`formspree.io/f/xgaoewgy`); listed in the privacy notice.

---

## Privacy and analytics (EU)
- Google Analytics 4 (G-EMZ0MM9TYB) loads only after the visitor accepts the banner from `js/consent.js` (Consent Mode v2, ad storage and personalisation denied; choice kept in localStorage; rejecting removes the `_ga` cookies).
- Every page includes `js/consent.js`, the self-hosted `assets/fonts/fonts.css`, and the footer line `Privacy · Cookie settings` (`<a href="#" data-consent-open>`).
- Never paste Google's raw gtag snippet into a page. Update `privacy.html` when a new third-party service is added.

---

## Writing tone (case studies and site copy)
- Measured, professional and informative: full sentences that say what was done and why it is useful.
- No blunt one-word openers or verdicts ("None.", "Speed only.", "No ML needed."), no slang ("a real trap") and no jokey asides.
- "Role of ML" box: lead with what ML contributes. Where a study uses no ML, describe the direct physics approach and explain why it suits the study, without framing ML as a mistake.
- "Physics" box: a scannable list of short items (bold label plus a one-line detail, `ul.phys-list`), not a run-on paragraph. Each detail names the actual method and what it captures (e.g. "Coupled thermal network that feeds magnet temperature back into the remanence"), never a restatement of the label ("Thermal network").
- State limits plainly under "Stated limits", in the same calm tone.
