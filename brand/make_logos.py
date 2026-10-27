"""Builds the EasyApt "EA floor plan" logo concepts as SVG, plus a PNG review sheet.

Every concept is the same idea drawn three ways: a floor plan whose walls spell E and A.
The E is a wing of rooms (spine = exterior wall, arms = interior walls); the A is the next
unit (its open bottom is the entrance) and its enclosed top room is the highlighted unit.
All geometry sits on a 96-unit grid with walls on whole-number centerlines.
"""
import os
import cairosvg
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.dirname(os.path.abspath(__file__))
COBALT, INK, MARK, WHITE = "#2F45C8", "#1C2421", "#F7DC4A", "#FFFFFF"


def svg(body, bg=None, rx=18):
    back = f'<rect width="96" height="96" rx="{rx}" fill="{bg}"/>' if bg else ""
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" role="img" aria-label="EasyApt">{back}{body}</svg>'


def bold(wall, mark=MARK, door_op=".55"):
    """Concept 1, Two units: heavy walls, the E wing and the A unit side by side."""
    return f'''
  <rect x="61" y="17" width="22" height="24" fill="{mark}"/>
  <g fill="none" stroke="{wall}" stroke-width="9" stroke-linecap="square" stroke-linejoin="miter">
    <path d="M42 84 H12 V12 H42"/>
    <path d="M12 48 H36"/>
    <path d="M57 84 V12 H84 V84"/>
    <path d="M57 46 H84"/>
  </g>
  <g fill="none" stroke="{wall}" stroke-width="2" stroke-opacity="{door_op}" stroke-linecap="round">
    <path d="M78.5 84 V71"/><path d="M65.5 84 A13 13 0 0 1 78.5 71"/>
  </g>'''


def blueprint(line=WHITE, mark=MARK):
    """Concept 2, Blueprint tile: the plan in white on cobalt, with dimension lines like a real drawing."""
    return f'''
  <g stroke="{line}" stroke-opacity=".45" stroke-width="1.6" fill="none" stroke-linecap="round">
    <path d="M20 10 H76"/><path d="M20 7 V13"/><path d="M76 7 V13"/><path d="M48 8 V12"/>
    <path d="M10 22 V78"/><path d="M7 22 H13"/><path d="M7 78 H13"/>
  </g>
  <rect x="55" y="25" width="17" height="17" fill="{mark}"/>
  <g fill="none" stroke="{line}" stroke-width="6.5" stroke-linecap="square" stroke-linejoin="miter">
    <path d="M42 78 H20 V22 H76 V78"/>
    <path d="M20 50 H37"/>
    <path d="M52 78 V22"/>
    <path d="M52 45 H76"/>
  </g>
  <g fill="none" stroke="{line}" stroke-width="1.8" stroke-opacity=".8" stroke-linecap="round">
    <path d="M72.5 78 V68"/><path d="M62.5 78 A10 10 0 0 1 72.5 68"/>
  </g>'''


def monoline(line=COBALT, mark=MARK):
    """Concept 3, Monoline: one even pen weight, rounded joins, door openings cut into the E's rooms."""
    return f'''
  <rect x="58" y="18" width="24" height="23" rx="2" fill="{mark}"/>
  <g fill="none" stroke="{line}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M40 14 H14 V82 H40"/>
    <path d="M14 48 H34"/>
    <path d="M55 82 V14 H85 V82"/>
    <path d="M55 44 H85"/>
  </g>
  <g fill="none" stroke="{line}" stroke-width="2" stroke-linecap="round" opacity=".6">
    <path d="M79 82 V70"/><path d="M67 82 A12 12 0 0 1 79 70"/>
  </g>'''


CONCEPTS = [
    ("1-two-units", "Two units", lambda: svg(bold(COBALT)), lambda: svg(bold(WHITE, door_op=".7"), bg=COBALT)),
    ("2-blueprint-tile", "Blueprint tile", lambda: svg(blueprint(), bg=COBALT), lambda: svg(blueprint(), bg=COBALT)),
    ("3-monoline", "Monoline", lambda: svg(monoline()), lambda: svg(monoline(WHITE), bg=COBALT)),
]


def render(svg_text, px, path, bg=None):
    cairosvg.svg2png(bytestring=svg_text.encode(), write_to=path, output_width=px, output_height=px, background_color=bg)
    return Image.open(path).convert("RGBA")


def main():
    font = ImageFont.truetype(os.path.expanduser("~/.fonts/Archivo-900.ttf"), 64)
    small = ImageFont.truetype(os.path.expanduser("~/.fonts/Archivo-800.ttf"), 22)
    rows = []
    for slug, title, light, dark in CONCEPTS:
        open(os.path.join(OUT, f"{slug}.svg"), "w").write(light())
        open(os.path.join(OUT, f"{slug}-icon.svg"), "w").write(dark())
        tmp = os.path.join(OUT, "_tmp.png")
        big = render(light(), 200, tmp, "white")
        icon = render(dark(), 120, tmp)
        fav32 = render(dark(), 32, tmp)
        fav16 = render(dark(), 16, tmp)
        row = Image.new("RGB", (1240, 250), "white")
        d = ImageDraw.Draw(row)
        d.text((24, 8), title, fill=INK, font=small)
        row.paste(big, (24, 40), big)
        lock = render(light(), 84, tmp, "white")
        row.paste(lock, (270, 95), lock)
        d.text((366, 98), "EasyApt", fill=INK, font=font)
        row.paste(icon, (770, 70), icon)
        row.paste(fav32, (920, 114), fav32)
        row.paste(fav16, (970, 122), fav16)
        # header-size lockup on the site's paper color
        strip = Image.new("RGB", (200, 50), "#F4F5F1")
        hs = render(light(), 30, tmp, "#F4F5F1")
        strip.paste(hs, (8, 10), hs)
        ImageDraw.Draw(strip).text((46, 12), "EasyApt", fill=INK, font=ImageFont.truetype(os.path.expanduser("~/.fonts/Archivo-900.ttf"), 22))
        row.paste(strip, (1020, 105))
        rows.append(row)
        os.remove(tmp)
    sheet = Image.new("RGB", (1240, 250 * len(rows)), "white")
    for i, r in enumerate(rows):
        sheet.paste(r, (0, 250 * i))
    sheet.save(os.path.join(OUT, "logo-concepts.png"))
    print("ok")


if __name__ == "__main__":
    main()
