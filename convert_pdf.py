# -*- coding: utf-8 -*-
"""
Подготовка страниц интерактивной книги из PDF.

Что делает:
  1. Конвертирует страницы PDF в WebP (170 dpi, качество 82).
  2. Приводит ВСЕ страницы к единому формату (по самому частому
     «интерьерному» размеру страницы PDF) — иначе флипбуку нечего ловить.
  3. «Развороты» (страницы PDF, ширина которых ~= 2x ширины обычной
     страницы) разрезает на две половины по линии сгиба.
  4. Обложки (чуть больший формат с вылетами) вписывает в общий
     формат методом заполнения с обрезкой краёв (~1%), чтобы не было
     белых полос.
  5. Пишет манифест assets/pages/pages.json для предзагрузчика.

Зависимости:  pip install pymupdf pillow
Запуск:       python convert_pdf.py
"""

import io
import json
import os
import sys
import time
from collections import Counter

import pymupdf
from PIL import Image, ImageOps

# ---------- НАСТРОЙКИ ----------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PDF_PATH = os.path.join(BASE_DIR, "Shvarzman_maket-FULL_web.pdf")
OUT_DIR = os.path.join(BASE_DIR, "assets", "pages")
DPI = 170                 # 150–200 dpi — баланс резкости и веса
QUALITY = 82              # качество WebP (0–100)
FORCE = True              # перегенерировать, даже если файлы есть
# --------------------------------


def render_page(doc, index, zoom):
    """Страница PDF -> PIL.Image в RGB (без альфы)."""
    pix = doc.load_page(index).get_pixmap(
        matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
    img = Image.open(io.BytesIO(pix.tobytes("png")))
    return img.convert("RGB") if img.mode != "RGB" else img


def normalize(img, target):
    """Вписать изображение в target-формат (fill + центрированная обрезка)."""
    if img.size == target:
        return img
    return ImageOps.fit(img, target, method=Image.LANCZOS, centering=(0.5, 0.5))


def main():
    if not os.path.isfile(PDF_PATH):
        sys.exit(f"PDF не найден: {PDF_PATH}")

    os.makedirs(OUT_DIR, exist_ok=True)
    doc = pymupdf.open(PDF_PATH)
    total = doc.page_count

    # 1. Определяем целевой формат = самый частый размер страницы PDF
    sizes = Counter()
    for i in range(total):
        r = doc.load_page(i).rect
        sizes[(round(r.width, 1), round(r.height, 1))] += 1
    (pw, ph), _ = sizes.most_common(1)[0]
    zoom = DPI / 72.0
    target = (round(pw * zoom), round(ph * zoom))          # напр. 871 x 1339
    # «Двустраничник» = страница заметно шире обычной (по пропорции)
    target_ratio = target[0] / target[1]
    spread_ratio = target_ratio * 1.5

    print(f"PDF: {os.path.basename(PDF_PATH)} — {total} стр., DPI={DPI}")
    print(f"Целевой формат: {target[0]}x{target[1]} px")
    print(f"Необычные форматы: "
          + ", ".join(f"{w}x{h}x{n}" for (w, h), n in sizes.most_common()))

    if not FORCE:
        existing = [f for f in os.listdir(OUT_DIR) if f.startswith("page-")]
        if existing:
            print(f"Файлы уже есть ({len(existing)}) — пропускаю. FORCE=True перегенерирует.")
            _write_manifest(doc, total, target)
            doc.close()
            return

    t0 = time.time()
    out_index = 0
    report = Counter()

    for i in range(total):
        img = render_page(doc, i, zoom)

        # 2. Разворот (пропорции ~2:1) — режем по линии сгиба
        if img.width / img.height >= spread_ratio:
            w2 = img.width // 2
            parts = [img.crop((0, 0, w2, img.height)),
                     img.crop((w2, 0, img.width, img.height))]
            report["spread"] += 1
        else:
            parts = [img]

        for part in parts:
            out_index += 1
            if part.size != target:
                report["fitted"] += 1
                part = normalize(part, target)
            path = os.path.join(OUT_DIR, f"page-{out_index}.webp")
            part.save(path, "WEBP", quality=QUALITY, method=6)
            print(f"  page-{out_index:3d}.webp  {part.width}x{part.height}  "
                  f"{os.path.getsize(path) / 1024:6.0f} KB")

    print(f"Готово: {out_index} страниц за {time.time() - t0:.1f} c. "
          f"(разрезано разворотов: {report['spread']}, "
          f"вписано в формат: {report['fitted']})")
    _write_manifest(doc, total, target, out_index)
    doc.close()


def _write_manifest(doc, total, target, out_index=None):
    """Манифест страниц для предзагрузчика."""
    files = sorted(
        (f for f in os.listdir(OUT_DIR) if f.startswith("page-") and f.endswith(".webp")),
        key=lambda f: int(f[5:-5]),
    )
    pages = []
    size_sum = 0
    for n, name in enumerate(files, start=1):
        path = os.path.join(OUT_DIR, name)
        b = os.path.getsize(path)
        size_sum += b
        pages.append({"src": f"assets/pages/{name}", "bytes": b})

    manifest = {
        "total": len(files),
        "width": target[0],
        "height": target[1],
        "aspect": round(target[0] / target[1], 5),
        "totalMB": round(size_sum / 1048576, 1),
        "pages": pages,
    }
    with open(os.path.join(OUT_DIR, "pages.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"Манифест: assets/pages/pages.json — {len(files)} стр., "
          f"{manifest['totalMB']} МБ, формат {target[0]}x{target[1]}")


if __name__ == "__main__":
    main()
