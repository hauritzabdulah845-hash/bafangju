# -*- coding: utf-8 -*-
"""
生成首页运营轮播成品 banner（5:2，1120×448），与 banner_ladder.jpg 同一套版式：
  深红底 + 左侧留白 + 金黄色渐变主标题（两行）+ 米色副标 + 米色圆角按钮
用法：
  python tools/make-ops-banners.py
输入：output/banner-gen/*.png（AI 生成的底图，右下角带生成水印，靠裁切裁掉）
输出：public/img/products/banner_invite.jpg、banner_nearby.jpg
"""
import pathlib
import sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = pathlib.Path(__file__).resolve().parents[2]          # 八方聚共享平台
OUT = pathlib.Path(__file__).resolve().parents[1] / 'public/img/products'
GEN = ROOT / 'output/banner-gen'

W, H = 1120, 448
FONT_BOLD = 'C:/Windows/Fonts/msyhbd.ttc'
FONT_REG = 'C:/Windows/Fonts/msyh.ttc'
LEFT = 64

HEAD_TOP_1 = 40
HEAD_SIZE = 92
HEAD_LINE = 104
SUB_Y = 276
SUB_SIZE = 26
BTN_Y = 316
BTN_H = 56
BTN_PAD = 30
BTN_SIZE = 27


def load_band(src, top):
    """按 5:2 裁切并缩放；裁切区间同时避开底图右下角的生成水印"""
    im = Image.open(src).convert('RGB')
    w, h = im.size
    ch = int(w / (W / H))
    top = max(0, min(top, h - ch))
    return im.crop((0, top, w, top + ch)).resize((W, H), Image.LANCZOS)


def left_shade(im, strength=0.5):
    """左侧压暗，保证文字对比度（与首帧 banner 的观感一致）"""
    shade = Image.new('L', (W, 1), 0)
    px = shade.load()
    for x in range(W):
        t = max(0.0, 1 - x / (W * 0.62))
        px[x, 0] = int(255 * strength * (t ** 1.35))
    mask = shade.resize((W, H))
    dark = Image.new('RGB', (W, H), (18, 6, 4))
    return Image.composite(dark, im, mask.point(lambda v: int(v * 0.92)))


def gradient_text(base, text, xy, font, top_color, bottom_color, shadow=True):
    """渐变填充文字：先画遮罩，再用垂直渐变上色"""
    d = ImageDraw.Draw(base)
    if shadow:
        sh = Image.new('RGBA', base.size, (0, 0, 0, 0))
        ImageDraw.Draw(sh).text((xy[0] + 2, xy[1] + 6), text, font=font, fill=(0, 0, 0, 150))
        base.alpha_composite(sh.filter(ImageFilter.GaussianBlur(7))) if base.mode == 'RGBA' else None
    bbox = d.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    mask = Image.new('L', (tw + 8, th + 12), 0)
    ImageDraw.Draw(mask).text((4 - bbox[0], 6 - bbox[1]), text, font=font, fill=255)
    grad = Image.new('RGB', mask.size)
    gp = grad.load()
    for y in range(mask.size[1]):
        t = y / max(1, mask.size[1] - 1)
        gp_row = tuple(int(top_color[i] + (bottom_color[i] - top_color[i]) * t) for i in range(3))
        for x in range(mask.size[0]):
            gp[x, y] = gp_row
    base.paste(grad, (xy[0] - 4, xy[1] - 6), mask)


def draw_banner(bg, lines, sub, btn):
    im = left_shade(bg).convert('RGBA')
    f_head = ImageFont.truetype(FONT_BOLD, HEAD_SIZE)
    f_sub = ImageFont.truetype(FONT_REG, SUB_SIZE)
    f_btn = ImageFont.truetype(FONT_BOLD, BTN_SIZE)

    # 主标题：两行，奶白到暖金的垂直渐变 + 柔和投影
    for i, line in enumerate(lines):
        gradient_text(im, line, (LEFT, HEAD_TOP_1 + i * HEAD_LINE), f_head, (255, 246, 224), (240, 190, 122))

    # 副标
    d = ImageDraw.Draw(im)
    d.text((LEFT + 2, SUB_Y + 1), sub, font=f_sub, fill=(0, 0, 0, 120))
    d.text((LEFT, SUB_Y), sub, font=f_sub, fill=(247, 224, 190))

    # 按钮：米色胶囊 + 深红字
    tw = d.textlength(btn, font=f_btn)
    bw, bh = int(tw + BTN_PAD * 2), BTN_H
    btn_img = Image.new('RGBA', (bw, bh), (0, 0, 0, 0))
    bd = ImageDraw.Draw(btn_img)
    bd.rounded_rectangle([0, 0, bw - 1, bh - 1], radius=bh // 2, fill=(255, 246, 232, 255))
    bd.text(((bw - tw) / 2, (bh - BTN_SIZE * 1.36) / 2), btn, font=f_btn, fill=(138, 31, 36, 255))
    im.alpha_composite(btn_img, (LEFT, BTN_Y))
    return im.convert('RGB')


JOBS = [
    {
        'src': GEN / '超宽横版电商促销_banner_背景图_深红至暗红渐变底色__2026-11-13T05-53-44.png',
        'top': 20,
        'lines': ['邀请好友', '一起省钱'],
        'sub': '把好物分享给朋友 · 一起买更划算',
        'btn': '去邀请好友',
        'out': OUT / 'banner_invite.jpg',
    },
    {
        'src': GEN / '超宽横版商业_banner_背景图_深红与暖金配色_右侧是温_2026-11-13T05-53-59.png',
        'top': 110,
        'lines': ['附近好店', '到店领券'],
        'sub': '异业联盟门店 · 走路就能到',
        'btn': '逛逛附近',
        'out': OUT / 'banner_nearby.jpg',
    },
]


def main():
    for job in JOBS:
        if not job['src'].exists():
            sys.exit('缺少底图：' + str(job['src']))
        bg = load_band(job['src'], job['top'])
        img = draw_banner(bg, job['lines'], job['sub'], job['btn'])
        img.save(job['out'], 'JPEG', quality=92, optimize=True, progressive=True)
        print(f"{job['out'].name}: {img.size[0]}x{img.size[1]} {job['out'].stat().st_size // 1024}KB")


if __name__ == '__main__':
    main()
