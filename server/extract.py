#!/usr/bin/env python3
"""把 PDF 抽成 DeepSeek 能吃的输入：带页码标记的全文 + 图表页的页面图。

用法：stdin 收 PDF 字节，stdout 吐一行 JSON。
不把论文内容写进任何日志，只在 stderr 报统计数字。
"""

import base64
import json
import re
import sys

import fitz  # PyMuPDF

MAX_IMAGES = 12          # 单篇最多送多少张页面图
SCANNED_CHARS_PER_PAGE = 200   # 低于这个密度就当扫描件处理
RENDER_DPI = 110         # 够看清坐标轴和表格数字，又不至于把 token 打爆
JPEG_QUALITY = 80
CAPTION = re.compile(r"(?:Figure|Fig\.?|Table|图|表)\s*\d+", re.IGNORECASE)


def page_has_visual(page, text):
    """判断这一页是否值得渲染成图片。"""
    if not CAPTION.search(text):
        return False
    for img in page.get_images(full=True):
        if img[2] * img[3] > 80_000:      # 宽 * 高，滤掉 logo 和公式碎图
            return True
    return len(page.get_drawings()) > 60   # 矢量画的折线图/柱状图


def guess_title(doc, first_page_text):
    meta = (doc.metadata or {}).get("title") or ""
    meta = meta.strip()
    if len(meta) > 6 and not meta.lower().endswith(".pdf"):
        return meta[:180]
    # 元数据不可信时，取首页最大字号的那行
    try:
        blocks = doc[0].get_text("dict")["blocks"]
        best, best_size = "", 0.0
        for block in blocks:
            for line in block.get("lines", []):
                size = max((s["size"] for s in line["spans"]), default=0)
                text = "".join(s["text"] for s in line["spans"]).strip()
                if size > best_size and len(text) > 6 and not text.lower().startswith("arxiv:"):
                    best, best_size = text, size
        if best:
            return best[:180]
    except Exception:
        pass
    return (first_page_text.strip().split("\n") or [""])[0][:180]


def main():
    raw = sys.stdin.buffer.read()
    doc = fitz.open(stream=raw, filetype="pdf")

    texts = [page.get_text() for page in doc]
    body = "".join(
        f"\n\n===== PAGE {i} =====\n\n{t}" for i, t in enumerate(texts, 1)
    ).strip()

    # 扫描件抽不出文字，只能整篇走视觉；否则只渲染含图表的页
    scanned = len(body) < SCANNED_CHARS_PER_PAGE * max(len(doc), 1)
    if scanned:
        candidates = list(range(len(doc)))
    else:
        candidates = [i for i, page in enumerate(doc) if page_has_visual(page, texts[i])]
    # 页数多时优先靠前的页：方法图通常比附录图重要
    if len(candidates) > MAX_IMAGES:
        candidates = candidates[:MAX_IMAGES]

    images = []
    for i in candidates:
        pix = doc[i].get_pixmap(dpi=RENDER_DPI)
        data = pix.tobytes("jpeg", jpg_quality=JPEG_QUALITY)
        images.append({"page": i + 1, "b64": base64.b64encode(data).decode()})

    result = {
        "title": guess_title(doc, texts[0] if texts else ""),
        "pages": len(doc),
        "text": body,
        "chars": len(body),
        "images": images,
        "figurePages": [i + 1 for i in candidates],
        "scanned": scanned,
    }
    sys.stderr.write(
        f"pages={result['pages']} chars={result['chars']} "
        f"images={len(images)} scanned={scanned}\n"
    )
    json.dump(result, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
