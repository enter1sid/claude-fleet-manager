# Generates the red "fleet" tray icons (stacked account cards). Usage: python3 scripts/make-icons.py
from PIL import Image, ImageDraw

S = 8  # supersample factor
N = 64


def draw(alert):
    img = Image.new('RGBA', (N * S, N * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((2 * S, 2 * S, 62 * S, 62 * S), radius=16 * S, fill=(229, 72, 77, 255))
    for i, a in enumerate((110, 190, 255)):
        y = (16 + i * 11) * S
        d.rounded_rectangle((14 * S, y, 50 * S, y + 9 * S), radius=4 * S, fill=(255, 255, 255, a))
    if alert:
        d.ellipse((38 * S, 38 * S, 62 * S, 62 * S), fill=(255, 193, 7, 255), outline=(22, 22, 26, 255), width=3 * S)
    return img.resize((N * 4, N * 4), Image.LANCZOS)


draw(False).save('assets/tray.png')
draw(True).save('assets/tray-alert.png')
draw(False).save('assets/icon.png')
