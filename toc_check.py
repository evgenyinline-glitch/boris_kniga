# -*- coding: utf-8 -*-
"""Содержание книги -> assets/pages/toc.json
1) находит печатный номер каждой страницы PDF (футер, низ страницы);
2) восполняет пропуски (страница «ФИНАЛЬНЫЙ ТОСТ» осталась без футера);
3) сопоставляет печатный номер с индексом WebP (см. convert_pdf.py);
4) парсит содержание (PDF 242-243 = webp 243-244), склеивая заголовки,
   разорванные в несколько строк;
5) проверяет каждый пункт по тексту целевой страницы."""
import re, json, sys, io, os, glob
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
import pymupdf

PDF = r"E:\2027\ШВАРТЦМАН САЙТ КНИГА\книга\Shvarzman_maket-FULL_web.pdf"
if not os.path.exists(PDF):
    PDF = glob.glob(r"E:\2027\ШВАРТЦМАН САЙТ КНИГА\книга\*.pdf")[0]
OUT = r"E:\2027\ШВАРТЦМАН САЙТ КНИГА\книга\assets\pages\toc.json"

doc = pymupdf.open(PDF)
N = len(doc)

def pdf_to_webp(p):
    """Индекс(ы) WebP для страницы PDF (см. convert_pdf.py)."""
    if p == 1: return [1]
    if p == 2: return [2, 3]            # разрезан разворот
    if 3 <= p <= 244: return [p + 1]
    if p == 245: return [246, 247]      # разрезан разворот
    if p == 246: return [248]
    return []

page_text = {i + 1: doc[i].get_text("text") for i in range(N)}

# ---------- 1. печатные номера (футер внизу страницы) ----------
printed = {}            # pdf page -> printed number
for p in range(1, N + 1):
    page = doc[p - 1]
    h = page.rect.height
    best = None
    for w in page.get_text("words"):
        x0, y0, x1, y1, txt = w[0], w[1], w[2], w[3], w[4]
        if y0 / h > 0.88 and y1 / h < 0.97 and re.fullmatch(r"\d{1,3}", txt):
            best = int(txt)
            break
    if best is not None:
        printed[p] = best

# ---------- 2. пропуски по последовательности ----------
known = sorted(printed.items())
filled = 0
for (p1, n1), (p2, n2) in zip(known, known[1:]):
    if p2 == p1 + 1:
        continue
    if p2 - p1 == 2 and n2 - n1 == 2:   # ровно одна страница без футера между
        printed[p1 + 1] = n1 + 1
        filled += 1
print(f"PDF {N} стр. | футеров: {len([1 for p in printed if p in [k for k,_ in known]])}"
      f" | восполнено: {filled} | печатных номеров: {len(printed)}")
print("печ.238 -> pdf", [p for p, n in printed.items() if n == 238],
      "-> webp", pdf_to_webp([p for p, n in printed.items() if n == 238][0]))

num_to_pdf = {}
for p, n in sorted(printed.items()):
    num_to_pdf.setdefault(n, p)

# ---------- 3. парсинг содержания ----------
toc_pdfs = []
for p in sorted(page_text):
    if "СОДЕРЖАНИЕ" in page_text[p].upper()[:300]:
        toc_pdfs = [p, p + 1]
        break
print("содержание: PDF", toc_pdfs, "-> webp", [pdf_to_webp(p) for p in toc_pdfs])

lines = []
for p in toc_pdfs:
    lines += [l.rstrip() for l in page_text[p].splitlines()]

TRAIL = re.compile(r"^(.*?)\s*(?:\.\s*){2,}\s*(\d{1,3})\s*$")

def is_heading(s):
    letters = [c for c in s if c.isalpha()]
    return len(letters) >= 4 and s == s.upper()

items, section, sub, pending, last_was_heading = [], "", "", [], False
for raw in lines:
    line = raw.replace("\u2002", " ").replace("\xa0", " ").replace("\u2009", " ").strip()
    if not line or line.upper() == "СОДЕРЖАНИЕ":
        continue
    if re.fullmatch(r"\d{1,3}", line):
        continue                            # футер страницы содержания
    m = TRAIL.match(line)
    if m:
        title = " ".join(pending + [m.group(1).strip()]).strip()
        title = re.sub(r"\s+", " ", title)
        if len(title) >= 3:
            items.append({"title": title, "printed": int(m.group(2)),
                          "section": section or "Предисловие", "sub": sub})
        pending, last_was_heading = [], False
    elif is_heading(line):
        section, sub, pending, last_was_heading = line, "", [], True
    elif last_was_heading:
        sub, last_was_heading = line, False       # подзаголовок раздела
    else:
        pending.append(line)                      # продолжение заголовка пункта
        last_was_heading = False

print("пунктов:", len(items))

# ---------- 4. проверка по тексту ----------
def norm(s):
    s = s.replace("\u2009", " ").replace("\xa0", " ").replace("ё", "е").replace("Ё", "Е")
    return re.sub(r"[^\wа-яa-z]+", " ", s.lower(), flags=re.I).strip()

bad = []
result = []
for it in items:
    main = re.split(r"\(", it["title"])[0].strip()
    pdf_p = num_to_pdf.get(it["printed"])
    page, ok = None, None
    if pdf_p:
        ws = pdf_to_webp(pdf_p)
        page = ws[0] if ws else None
        if page:
            hay = " ".join(norm(page_text.get(pdf_p + k, "")) for k in (0, 1, 2))
            words = [w for w in norm(main).split() if len(w) > 2][:3]
            hits = sum(1 for w in words if w in hay)
            ok = hits >= max(1, min(2, len(words)))
    if not ok:
        bad.append(it["title"])
    result.append({"title": it["title"], "section": it["section"], "sub": it["sub"],
                   "printed": it["printed"], "page": page, "ok": bool(ok)})

for r in result:
    print(("OK " if r["ok"] else "!!!"), f'печ.{r["printed"]:>4} -> webp {str(r["page"]):>4}',
          "|", r["section"], "|", r["title"])
print("\nне подтверждено:", len(bad), bad)

with open(OUT, "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=1)
print("->", OUT)

# ---------- 5. данные для меню (assets/pages/toc.js, читается app.js) ----------
def clean(s):
    s = re.sub(r"[\u00ad\u2009\u00a0\u2002]", " ", s or "")
    return re.sub(r"\s+", " ", s).strip()

compact = [{"t": clean(r["title"]), "s": clean(r["section"]), "u": clean(r.get("sub", "")),
            "p": r["page"], "n": r["printed"]} for r in result]
JS = OUT[:-5] + ".js"
with open(JS, "w", encoding="utf-8") as f:
    f.write("/* Содержание книги — сгенерировано toc_check.py. "
            f"{len(compact)} пунктов, все сверены с текстом страниц. */\n")
    f.write("window.__TOC = " + json.dumps(compact, ensure_ascii=False,
                                           separators=(",", ":")) + ";\n")
print("->", JS)
