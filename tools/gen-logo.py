# Generates assets/logo4.png - Orzic lockup: metaball fusion mark (two droplets merging
# into one, Y-shape) + Futura wordmark. Pure magenta. Run: python tools/gen-logo.py (Pillow)
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os

S = 6                        # supersample
SIZE = 320
MAGENTA = (255, 0, 255, 255)

def bezier(p0, p1, p2, n=48):
    pts = []
    for i in range(n + 1):
        t = i / n; mt = 1 - t
        pts.append((mt*mt*p0[0] + 2*mt*t*p1[0] + t*t*p2[0],
                    mt*mt*p0[1] + 2*mt*t*p1[1] + t*t*p2[1]))
    return pts

def mark(size):
    """Two bulb-tipped stems merge into one descending stem - organic metaball Y."""
    s = size / 320.0
    sc = lambda v: v * s
    L = (sc(80), sc(78))     # left bulb center
    R = (sc(262), sc(54))    # right bulb center (bigger, longer arm)
    B = (sc(98), sc(246))    # bottom bulb center
    J = (sc(132), sc(160))   # junction
    rL, rR, rB = sc(26), sc(42), sc(24)
    mask = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(mask)
    # endpoint bulbs
    for (x, y), r in [(L, rL), (R, rR), (B, rB)]:
        d.ellipse([x-r, y-r, x+r, y+r], fill=255)
    # junction blob
    jr = sc(22)
    d.ellipse([J[0]-jr, J[1]-jr, J[0]+jr, J[1]+jr], fill=255)
    # stems: quadratic beziers L->J, R->J, J->B
    for pts, w in [
        (bezier(L, (sc(120), sc(140)), J), int(sc(24))),
        (bezier(R, (sc(240), sc(140)), J), int(sc(30))),
        (bezier(J, (sc(100), sc(200)), B), int(sc(28))),
    ]:
        d.line(pts, fill=255, width=w, joint='curve')
        for x, y in pts[::5]:
            d.ellipse([x-w/2, y-w/2, x+w/2, y+w/2], fill=255)
    # goo-ify
    mask = mask.filter(ImageFilter.GaussianBlur(sc(9)))
    mask = mask.point(lambda v: 255 if v > 140 else 0)
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.putalpha(mask)
    tint = Image.new('RGBA', (size, size), MAGENTA)
    tint.putalpha(mask)
    return tint

m = mark(SIZE * S)
font = None
for cand in ('C:/Windows/Fonts/Futura Md BT Medium.ttf',
             'C:/Windows/Fonts/Futura Md BT Bold.ttf',
             'C:/Windows/Fonts/segoeuib.ttf'):
    if os.path.exists(cand):
        font = ImageFont.truetype(cand, int(SIZE * S * 0.58)); break
word = 'Orzic'
tmp = Image.new('RGBA', (8, 8)); td = ImageDraw.Draw(tmp)
bb = td.textbbox((0, 0), word, font=font); tw, th = bb[2]-bb[0], bb[3]-bb[1]
GAP = int(SIZE * S * 0.10)
W = SIZE*S + GAP + tw; H = SIZE*S
out = Image.new('RGBA', (W, H), (0, 0, 0, 0))
out.paste(m, (0, 0), m)
d = ImageDraw.Draw(out)
d.text((SIZE*S + GAP - bb[0], (H-th)//2 - int(bb[1]*0.9)), word, font=font, fill=MAGENTA)
out = out.resize((W//S, H//S), Image.LANCZOS)
out.save('assets/logo4.png')
print('wrote assets/logo4.png', out.size)
