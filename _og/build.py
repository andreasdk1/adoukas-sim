"""Link-preview cards (Open Graph, 1200 x 630) for the case pages.

Each entry in cards.json gives a case page's slug, a short title, its key result and a picture from the
project (with background size/position for the crop). The card is laid out in HTML with the site's own
fonts and monogram, screenshotted with headless Chrome and saved as assets/og/<slug>.jpg.

    python3 _og/build.py              # all cards
    python3 _og/build.py cocktail     # just one

Needs only Google Chrome and macOS `sips`. Folders starting with "_" are not published by GitHub Pages
(Jekyll), so this script and its sources stay out of the live site.
"""
import html, json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'assets', 'og')
TMP = os.path.join(HERE, 'build')
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

MONO = ('<svg class="mono" viewBox="0 0 104 74"><path d="M4,70 L30,6 L56,70" fill="none" stroke="currentColor" '
        'stroke-width="5" stroke-linejoin="round"/><path d="M34,46 L43.8,70" stroke="#5a80c8" stroke-width="5"/>'
        '<path d="M40,6 H70 A32,32 0 0 1 70,70 H60" fill="none" stroke="currentColor" stroke-width="5"/></svg>')

PAGE = """<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="../assets/fonts/fonts.css">
<style>
  * {{ margin: 0; box-sizing: border-box; }}
  html, body {{ width: 1200px; height: 630px; overflow: hidden; background: #080e1e; color: #e8eefb; }}
  .pic {{ position: absolute; left: 560px; top: 0; right: 0; bottom: 0;
         background: #080e1e url("{image}") no-repeat; background-size: {size}; background-position: {pos}; }}
  .pic::after {{ content: ""; position: absolute; inset: 0;
         background: linear-gradient(90deg, #080e1e 0%, rgba(8,14,30,.7) 14%, rgba(8,14,30,.15) 45%, rgba(8,14,30,0) 100%),
                    linear-gradient(180deg, #080e1e 0%, rgba(8,14,30,0) 15%, rgba(8,14,30,0) 82%, #080e1e 100%); }}
  .txt {{ position: absolute; left: 68px; top: 64px; bottom: 56px; width: 560px; display: flex; flex-direction: column; }}
  .brand {{ display: flex; align-items: center; gap: 22px; }}
  .mono {{ width: 84px; color: #e8eefb; }}
  .wm {{ border-left: 1px solid rgba(169,192,234,.35); padding-left: 22px; }}
  .name {{ font: 400 30px/1 Montserrat, sans-serif; letter-spacing: .24em; text-transform: uppercase; }}
  .tag {{ margin-top: 12px; font: 400 13px/1 Montserrat, sans-serif; letter-spacing: .22em; text-transform: uppercase; color: #5a80c8; }}
  .main {{ margin-top: auto; }}
  .eyebrow {{ font: 500 16px/1 "JetBrains Mono", monospace; letter-spacing: .18em; text-transform: uppercase; color: #a9c0ea; }}
  h1 {{ margin-top: 18px; font: 600 50px/1.1 Inter, sans-serif; letter-spacing: -.01em; color: #fff;
        text-shadow: 0 2px 18px rgba(8,14,30,.8); }}
  .result {{ margin-top: 20px; font: 400 26px/1.3 Inter, sans-serif; color: #a9c0ea; text-shadow: 0 2px 14px rgba(8,14,30,.9); }}
  .url {{ margin-top: 30px; font: 400 15px/1 "JetBrains Mono", monospace; color: #6b7591; letter-spacing: .04em; }}
</style></head><body>
<div class="pic"></div>
<div class="txt">
  <div class="brand">{mono}<div class="wm"><div class="name">Andreas Doukas</div>
    <div class="tag">Simulation · Optimization · Performance</div></div></div>
  <div class="main">
    <div class="eyebrow">Case study</div>
    <h1>{title}</h1>
    <div class="result">{result}</div>
    <div class="url">sim.adoukas.eu</div>
  </div>
</div>
</body></html>"""


def build(card):
    os.makedirs(TMP, exist_ok=True); os.makedirs(OUT, exist_ok=True)
    image = os.path.relpath(os.path.join(HERE, card['image']), TMP)
    page = os.path.join(TMP, card['slug'] + '.html')
    with open(page, 'w') as f:
        f.write(PAGE.format(image=image, size=card['size'], pos=card['pos'], mono=MONO,
                            title=html.escape(card['title']), result=html.escape(card['result'])))
    png = os.path.join(TMP, card['slug'] + '.png')
    subprocess.run([CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
                    '--allow-file-access-from-files', '--virtual-time-budget=4000', '--window-size=1200,630',
                    f'--screenshot={png}', 'file://' + page], check=True, capture_output=True)
    jpg = os.path.join(OUT, card['slug'] + '.jpg')
    subprocess.run(['sips', '-s', 'format', 'jpeg', '-s', 'formatOptions', '85', png, '--out', jpg],
                   check=True, capture_output=True)
    print('wrote', os.path.relpath(jpg, os.path.join(HERE, '..')))


if __name__ == '__main__':
    cards = json.load(open(os.path.join(HERE, 'cards.json')))
    only = set(sys.argv[1:])
    for c in cards:
        if not only or c['slug'] in only:
            build(c)
