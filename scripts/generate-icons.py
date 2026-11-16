from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024
OUTPUT = Path(__file__).resolve().parent.parent / "assets"


def vertical_gradient(size: int) -> Image.Image:
    image = Image.new("RGBA", (size, size))
    pixels = image.load()
    top = (26, 29, 37)
    bottom = (7, 8, 11)
    for y in range(size):
        ratio = y / (size - 1)
        color = tuple(round(top[i] * (1 - ratio) + bottom[i] * ratio) for i in range(3))
        for x in range(size):
            pixels[x, y] = (*color, 255)
    return image


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def build_icon() -> Image.Image:
    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    background = vertical_gradient(SIZE)

    glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.ellipse((470, -250, 1300, 590), fill=(255, 106, 61, 95))
    glow = glow.filter(ImageFilter.GaussianBlur(150))
    background.alpha_composite(glow)

    grid = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    grid_draw = ImageDraw.Draw(grid)
    for position in range(0, SIZE, 64):
        grid_draw.line((position, 0, position, SIZE), fill=(255, 255, 255, 9), width=1)
        grid_draw.line((0, position, SIZE, position), fill=(255, 255, 255, 9), width=1)
    background.alpha_composite(grid)

    canvas.alpha_composite(background)
    canvas.putalpha(rounded_mask(SIZE, 216))

    border = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    border_draw = ImageDraw.Draw(border)
    border_draw.rounded_rectangle((5, 5, SIZE - 6, SIZE - 6), radius=212, outline=(255, 255, 255, 25), width=7)
    canvas.alpha_composite(border)

    icon = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(icon)
    orange = (255, 106, 61, 255)
    orange_light = (255, 154, 122, 255)
    cream = (255, 241, 233, 255)

    left, top, right, bottom = 238, 238, 786, 786
    arm = 132
    thickness = 52
    corners = [
        [(left + arm, top), (left, top), (left, top + arm)],
        [(right - arm, top), (right, top), (right, top + arm)],
        [(left + arm, bottom), (left, bottom), (left, bottom - arm)],
        [(right - arm, bottom), (right, bottom), (right, bottom - arm)],
    ]
    for points in corners:
        draw.line(points, fill=orange, width=thickness, joint="curve")
        for x, y in points:
            radius = thickness // 2
            draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=orange)

    draw.ellipse((392, 392, 632, 632), outline=(255, 138, 99, 80), width=8)
    draw.ellipse((428, 428, 596, 596), outline=(255, 255, 255, 34), width=4)

    play = [(474, 420), (474, 604), (626, 512)]
    draw.polygon(play, fill=cream)
    draw.line((play[0][0], play[0][1], play[1][0], play[1][1]), fill=orange_light, width=5)

    draw.ellipse((754, 196, 800, 242), fill=orange)
    draw.ellipse((768, 210, 786, 228), fill=cream)

    icon = icon.filter(ImageFilter.GaussianBlur(0.4))
    canvas.alpha_composite(icon)
    return canvas


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    icon = build_icon()
    icon.save(OUTPUT / "icon.png")
    icon.save(
        OUTPUT / "icon.ico",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print(f"Generated {OUTPUT / 'icon.png'}")
    print(f"Generated {OUTPUT / 'icon.ico'}")


if __name__ == "__main__":
    main()
