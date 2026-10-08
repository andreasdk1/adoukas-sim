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

### Adding a case (checklist)
Every new case page goes out with its search-engine tags and its own preview card. Copy the `<head>` of an existing case page and change:

1. **`<title>`**: lead with the words an engineer would search for, then ` – Andreas Doukas` (e.g. "CISPR 25 conducted emission simulation of a motor inverter – Andreas Doukas").
2. **`<meta name="description">`**: written from the page's content, at most 155 characters, saying what was simulated and the key result. Use the same text for `og:description`.
3. **`<link rel="canonical">` and `og:url`**: `https://sim.adoukas.eu/cases/<slug>.html`.
4. **Open Graph tags**: `og:title` (the page heading), `og:type` = article, `og:site_name` = Andreas Doukas Simulations, `og:locale` = en_GB, plus the image tags in step 5.
5. **Preview card**: add an entry to `_og/cards.json` (slug, short title, key result, a picture from the project and its crop), run `python3 _og/build.py <slug>` and look at `assets/og/<slug>.jpg`: no app toolbars or stray labels in view, text readable. Point `og:image` and `twitter:image` at `https://sim.adoukas.eu/assets/og/<slug>.jpg`, with `og:image:width` 1200, `og:image:height` 630 and an `og:image:alt`. Source pictures that are not on the site go in `_og/src/` (folders starting with `_` are not published).
6. **Structured data**: the schema.org `TechArticle` block before `</head>` (headline = page heading, description, url, image = the preview card; author and publisher by `@id` as in the existing pages). Check that it parses as JSON.
7. **Page basics**: `js/consent.js`, `assets/fonts/fonts.css` and the footer `Privacy · Cookie settings` line (see below).
8. **Links**: a card in the case-studies section of `index.html`, an entry in the table above, and a `<url>` with today's `lastmod` in `sitemap.xml`.
9. After publishing, check the preview with LinkedIn's Post Inspector (linkedin.com/post-inspector), which also refreshes LinkedIn's cached copy.

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
