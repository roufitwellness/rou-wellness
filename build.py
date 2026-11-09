#!/usr/bin/env python3
"""Rou Wellness 部落格產生器：讀 content/ 的文章與 assets/images/ 的照片，輸出可直接上傳的 site/ 資料夾。"""
import html
import json
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).parent
OUT = ROOT / "site"
IMG_DIR = ROOT / "assets" / "images"

# ---------- 這一區是網站設定，要改名字、連結、服務項目都在這裡 ----------
SITE_URL = "https://rou-wellness.roufitwellness.workers.dev"  # 若網址被用走，改這一行再重新產生
SITE_NAME = "Rou Wellness 柔柔老師"
NAME = "柔柔老師"
SLOGAN = "Be as you are, Glow as you heal."
ROLE_LINE = "台中｜具醫療專業背景的皮拉提斯與重訓教練"
HOME_TITLE = "Rou Wellness 柔柔老師｜台中皮拉提斯與重訓教練"
HOME_DESC = "柔柔老師是台中的皮拉提斯與重訓教練，具醫療專業背景。分享重訓與皮拉提斯的動作要點，以及營養、代謝健康與復健相關知識。"
IG = "https://www.instagram.com/rou_wellness/"
FB = "https://www.facebook.com/share/1CLFqLeUiY/?mibextid=wwXIfr"
LINE = ""  # 填上 LINE 官方帳號加入好友網址，按鈕就會出現
HERO_IMAGE = "hero.jpg"  # 放在 assets/images/ 裡，沒有這張就顯示柔和的粉色拱形
FEEDBACK_FORM = "https://docs.google.com/forms/d/e/1FAIpQLSdM_FAwGiM1tsLhVmob-rxHSd9r-rrzxENMnuYXc87CGsfefA/viewform?embedded=true"

NOTICE = "目前時間比較有限，2027 年 3 月前暫不接新學員。有任何問題，還是歡迎傳訊息給我，我會回覆你。"

SERVICES = [
    {"name": "一對一皮拉提斯", "desc": "依你的身體狀況與目標，一對一調整動作。", "image": "service-1.png"},
    {"name": "小團體皮拉提斯", "desc": "小班教學，人數有上限，節奏比較從容。", "image": "service-2.png"},
    {"name": "淋巴引流", "desc": "一種輕柔的手技，幫助身體放鬆。", "image": "service-3.png"},
]
DISCLAIMER = "本站內容為一般運動與健康促進資訊，不能取代醫療專業的評估與建議。"
# 文章分類（對應粉專的五大知識系列與配色）。文章檔的 category 要寫跟 name 一樣的名稱。
CATEGORIES = [
    {"slug": "strength", "name": "重訓動作要點", "desc": "重量訓練的動作重點、常見代償與安全注意事項。", "color": "#2F6F5E", "bg": "#EEF2EE"},
    {"slug": "pilates", "name": "皮拉提斯動作要點", "desc": "皮拉提斯的動作控制、呼吸，以及骨盆與脊椎的排列。", "color": "#4F7396", "bg": "#EDF1F5"},
    {"slug": "metabolic", "name": "代謝健康", "desc": "血糖、胰島素、能量代謝、睡眠與壓力的相關知識。", "color": "#9B4022", "bg": "#F0DFC8"},
    {"slug": "nutrition", "name": "營養學", "desc": "巨量與微量營養素、食物來源與日常飲食的營養知識。", "color": "#8E4B58", "bg": "#F8E5E9"},
    {"slug": "rehab", "name": "復健相關知識", "desc": "關節力學、動作控制與身體功能的相關知識。", "color": "#514B35", "bg": "#FAF7E9"},
]
# 連載系列。文章檔用 series 與 episode 兩個欄位指定。
SERIES = [
    {"slug": "lower-body-squat", "name": "下肢蹲系列", "desc": "一集一個蹲類動作，整理動作重點與注意事項。"},
]
# ----------------------------------------------------------------------


def esc(s):
    return html.escape(s, quote=True)


def has_img(name):
    return bool(name) and (IMG_DIR / name).exists()


def img(name, alt, eager=False):
    return f'<img src="/images/{esc(name)}" alt="{esc(alt)}" decoding="async"' + ("" if eager else ' loading="lazy"') + ">"


def inline(text):
    t = esc(text)
    t = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", t)
    t = re.sub(r"\[([^\]]+)\]\((https?://[^)\s]+)\)", r'<a href="\2" rel="noopener" target="_blank">\1</a>', t)
    return t


def md_to_html(body):
    out, para, items, kind = [], [], [], None

    def flush_para():
        if para:
            out.append("<p>" + inline(" ".join(para)) + "</p>")
            para.clear()

    def flush_list():
        nonlocal kind
        if items:
            tag = "ul" if kind == "ul" else "ol"
            out.append(f"<{tag}>" + "".join(f"<li>{inline(i)}</li>" for i in items) + f"</{tag}>")
            items.clear()
        kind = None

    for line in body.splitlines():
        s = line.strip()
        if not s:
            flush_para(); flush_list(); continue
        if s.startswith("### "):
            flush_para(); flush_list(); out.append(f"<h3>{inline(s[4:])}</h3>")
        elif s.startswith("## "):
            flush_para(); flush_list(); out.append(f"<h2>{inline(s[3:])}</h2>")
        elif s.startswith("- "):
            flush_para()
            if kind != "ul": flush_list(); kind = "ul"
            items.append(s[2:])
        elif re.match(r"\d+\.\s", s):
            flush_para()
            if kind != "ol": flush_list(); kind = "ol"
            items.append(re.sub(r"^\d+\.\s", "", s))
        else:
            flush_list(); para.append(s)
    flush_para(); flush_list()
    return "\n".join(out)


def load(path):
    raw = path.read_text(encoding="utf8")
    head, body = raw.split("\n---\n", 1)
    meta = {}
    for line in head.splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            meta[k.strip()] = v.strip()
    meta["body"] = body.strip()
    return meta


def zh_date(d):
    y, m, dd = d.split("-")
    return f"{int(y)}年{int(m)}月{int(dd)}日"


def cat_by_name(name):
    for c in CATEGORIES:
        if c["name"] == name:
            return c
    return None


def cat_style(c):
    return f'--c:{c["color"]};--b:{c["bg"]}' if c else ""


def chip(c, link=True):
    if not c:
        return ""
    if link:
        return f'<a class="chip" href="/category/{c["slug"]}/" style="{cat_style(c)}">{esc(c["name"])}</a>'
    return f'<span class="chip" style="{cat_style(c)}">{esc(c["name"])}</span>'


ICON_IG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17" cy="7" r="1" fill="currentColor" stroke="none"/></svg>'
ICON_FB = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13.6 21v-7.6h2.6l.4-3h-3V8.5c0-.9.3-1.5 1.5-1.5h1.6V4.3c-.3 0-1.2-.1-2.3-.1-2.3 0-3.8 1.4-3.8 3.9v2.3H8v3h2.6V21z"/></svg>'
ICON_LINE = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3.5c-5 0-9 3.2-9 7.2 0 3.5 3.1 6.4 7.3 7 .3.1.7.3.8.6l.1 1c0 .3-.2 1 .9.6 1.1-.5 5.8-3.4 7.9-5.9 1.3-1.5 2-3 2-4.3 0-4-4-7.2-9-7.2z"/></svg>'


def social():
    links = [(IG, "Instagram", "IG", ICON_IG), (FB, "Facebook", "FB", ICON_FB), (LINE, "LINE 官方帳號", "LINE", ICON_LINE)]
    items = "".join(
        f'<a href="{esc(u)}" rel="noopener" target="_blank" aria-label="{esc(label)}">{icon}<span>{short}</span></a>'
        for u, label, short, icon in links if u
    )
    return f'<aside class="social" aria-label="社群連結">{items}</aside>'


def closing():
    btns = "".join(
        f'<a class="btn" href="{esc(u)}" rel="noopener" target="_blank">{label}</a>'
        for u, label in [(IG, "Instagram"), (FB, "Facebook"), (LINE, "LINE 官方帳號")] if u
    )
    return (
        '<section class="closing"><div class="closing-in">'
        f'<p class="slogan">{esc(SLOGAN)}</p>'
        '<h2>想了解適合你的課程？</h2>'
        '<p>Instagram 有不一樣的內容，歡迎追蹤。</p>'
        f'<div class="closing-btns">{btns}</div>'
        '<nav class="closing-nav" aria-label="網站連結"><a href="/posts/">文章</a><a href="/#services">服務</a><a href="/about/">關於</a><a href="/feedback/">學員回饋</a></nav>'
        '</div></section>'
    )


def page(title, desc, path, main, kind="website", ld=None, full_title=None):
    url = SITE_URL + path
    t = full_title or f"{title}｜{SITE_NAME}"
    ld_tag = ""
    if ld:
        ld_tag = '<script type="application/ld+json">' + json.dumps(ld, ensure_ascii=False).replace("</", "<\\/") + "</script>"
    return f"""<!doctype html>
<html lang="zh-Hant-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>{esc(t)}</title>
<meta name="description" content="{esc(desc)}">
<link rel="canonical" href="{url}">
<meta property="og:type" content="{kind}">
<meta property="og:site_name" content="{esc(SITE_NAME)}">
<meta property="og:title" content="{esc(t)}">
<meta property="og:description" content="{esc(desc)}">
<meta property="og:url" content="{url}">
<meta property="og:locale" content="zh_TW">
<meta name="twitter:card" content="summary">
<meta name="theme-color" content="#FBF4F2">
<meta name="google-site-verification" content="rgBamp5bB5_OIsSn6_DsuY9uL47e_mf1MT2KMcageq4" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@1,500&family=Noto+Sans+TC:wght@300;400;500&family=Noto+Serif+TC:wght@500;600&display=swap">
<link rel="stylesheet" href="/style.css">
{ld_tag}
</head>
<body>
<div class="wrap">
<header class="top">
  <a class="brand" href="/">{esc(SITE_NAME)}</a>
  <nav aria-label="主選單"><a href="/posts/">文章</a><a href="/#services">服務</a><a href="/about/">關於</a></nav>
</header>
<main>
{main}
</main>
{closing()}
<footer class="site-footer">
  <p>{esc(DISCLAIMER)}</p>
  <p>Copyright © 2026 rou_wellness</p>
</footer>
</div>
{social()}
</body>
</html>
"""


def card(p):
    c = cat_by_name(p.get("category"))
    thumb = img(p["image"], p["title"]) if has_img(p.get("image")) else f'<span class="thumb-ph">{esc(p.get("category", ""))}</span>'
    ser = f'<span class="ser">{esc(p["series"])} EP{esc(p["episode"])}</span>' if p.get("series") and p.get("episode") else ""
    return (
        f'<a class="card" href="/posts/{p["slug"]}/"><div class="thumb" style="{cat_style(c)}">{thumb}</div>'
        f'<div class="tags">{chip(c, link=False)}{ser}</div>'
        f'<div class="meta">{zh_date(p["date"])}</div><h3>{esc(p["title"])}</h3>'
        f'<p>{esc(p["description"])}</p><span class="more">閱讀全文 →</span></a>'
    )


def write(rel, content):
    p = OUT / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf8")


def copy_images():
    if not IMG_DIR.exists():
        return
    dest = OUT / "images"
    dest.mkdir(exist_ok=True)
    try:
        from PIL import Image  # 有安裝就順便縮小照片，網站才會快
    except Exception:
        Image = None
    for f in sorted(IMG_DIR.iterdir()):
        if not f.is_file():
            continue
        if Image and f.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp"):
            try:
                im = Image.open(f)
                im.thumbnail((1600, 1600))
                if f.suffix.lower() in (".jpg", ".jpeg"):
                    im.convert("RGB").save(dest / f.name, quality=82, optimize=True)
                else:
                    im.save(dest / f.name, optimize=True)
                continue
            except Exception:
                pass
        shutil.copy(f, dest / f.name)


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir()
    shutil.copy(ROOT / "assets" / "style.css", OUT / "style.css")
    shutil.copy(ROOT / "assets" / "favicon.svg", OUT / "favicon.svg")
    copy_images()

    posts = [load(p) for p in sorted((ROOT / "content" / "posts").glob("*.md"))]
    posts.sort(key=lambda p: p["date"], reverse=True)
    about = load(ROOT / "content" / "about.md")

    # 只顯示已經有文章的分類，空的分類不會出現
    used = [c for c in CATEGORIES if any(p.get("category") == c["name"] for p in posts)]

    def filter_bar(active=None):
        links = [f'<a class="fchip{" on" if active is None else ""}" href="/posts/">全部</a>']
        for c in used:
            on = " on" if active == c["slug"] else ""
            links.append(f'<a class="fchip{on}" href="/category/{c["slug"]}/" style="{cat_style(c)}">{esc(c["name"])}</a>')
        return '<nav class="filters" aria-label="文章分類">' + "".join(links) + "</nav>"

    # 首頁
    hero_media = img(HERO_IMAGE, NAME, eager=True) if has_img(HERO_IMAGE) else ""
    svcs = "".join(
        f'<div class="svc"><div class="svc-img">{img(s["image"], s["name"]) if has_img(s.get("image")) else ""}</div>'
        f'<h3>{esc(s["name"])}</h3><p>{esc(s["desc"])}</p></div>'
        for s in SERVICES
    )
    home = f"""<section class="hero">
  <div class="hero-text">
    <div class="eyebrow">ROU WELLNESS</div>
    <h1>{NAME}</h1>
    <p class="slogan">{esc(SLOGAN)}</p>
    <p class="role">{esc(ROLE_LINE)}</p>
    <a class="btn" href="/posts/">看最新文章</a>
  </div>
  <div class="arch">{hero_media}</div>
</section>
<p class="notice">{esc(NOTICE)}</p>
<section class="sec">
  <h2>最新文章</h2><div class="sub">LATEST</div>
  {filter_bar()}
  <div class="cards">{"".join(card(p) for p in posts[:4])}</div>
  <p class="all"><a href="/posts/">看全部文章 →</a></p>
</section>
<section class="sec" id="services">
  <h2>服務項目</h2><div class="sub">SERVICES</div>
  <div class="svcs">{svcs}</div>
</section>"""
    ld = {"@context": "https://schema.org", "@type": "Person", "name": NAME, "url": SITE_URL + "/",
          "jobTitle": "皮拉提斯與重訓教練", "sameAs": [u for u in (IG, FB, LINE) if u]}
    write("index.html", page(SITE_NAME, HOME_DESC, "/", home, ld=ld, full_title=HOME_TITLE))

    # 文章列表
    write("posts/index.html", page("全部文章", "重訓、皮拉提斯、營養、代謝健康與復健相關知識，所有文章列表。", "/posts/",
          f'<section class="sec first"><h1 class="page-title">全部文章</h1>{filter_bar()}<div class="cards">{"".join(card(p) for p in posts)}</div></section>'))

    # 分類頁
    for c in used:
        ps = [p for p in posts if p.get("category") == c["name"]]
        write(f'category/{c["slug"]}/index.html', page(c["name"], c["desc"], f'/category/{c["slug"]}/',
              f'<section class="sec first"><h1 class="page-title">{esc(c["name"])}</h1><p class="lead">{esc(c["desc"])}</p>{filter_bar(c["slug"])}<div class="cards">{"".join(card(p) for p in ps)}</div></section>'))

    # 系列頁
    used_series = []
    for s in SERIES:
        ps = sorted([p for p in posts if p.get("series") == s["name"]], key=lambda p: int(p.get("episode") or 0))
        if ps:
            used_series.append(s)
            write(f'series/{s["slug"]}/index.html', page(s["name"], s["desc"], f'/series/{s["slug"]}/',
                  f'<section class="sec first"><h1 class="page-title">{esc(s["name"])}</h1><p class="lead">{esc(s["desc"])}</p><div class="cards">{"".join(card(p) for p in ps)}</div></section>'))

    # 單篇文章
    for p in posts:
        others = [o for o in posts if o["slug"] != p["slug"]][:2]
        more = f'<section class="sec"><h2>更多文章</h2><div class="cards">{"".join(card(o) for o in others)}</div></section>' if others else ""
        cover = f'<div class="cover">{img(p["image"], p["title"], eager=True)}</div>' if has_img(p.get("image")) else ""
        c = cat_by_name(p.get("category"))
        ser = next((s for s in SERIES if s["name"] == p.get("series")), None)
        ser_html = f'<a class="ser" href="/series/{ser["slug"]}/">{esc(ser["name"])} EP{esc(p.get("episode", ""))}</a>' if ser else ""
        main_html = f"""<article class="post">
  <p class="crumb"><a href="/posts/">← 全部文章</a></p>
  <div class="tags">{chip(c)}{ser_html}</div>
  <h1 class="page-title">{esc(p["title"])}</h1>
  <p class="meta">{zh_date(p["date"])}・{NAME}</p>
  {cover}
  <div class="prose">
{md_to_html(p["body"])}
  </div>
</article>
{more}"""
        ld = {"@context": "https://schema.org", "@type": "Article", "headline": p["title"], "description": p["description"],
              "datePublished": p["date"], "dateModified": p["date"], "inLanguage": "zh-Hant-TW",
              "author": {"@type": "Person", "name": NAME}, "mainEntityOfPage": f'{SITE_URL}/posts/{p["slug"]}/'}
        write(f'posts/{p["slug"]}/index.html', page(p["title"], p["description"], f'/posts/{p["slug"]}/', main_html, kind="article", ld=ld))

    # 關於
    cover = f'<div class="cover">{img(about["image"], about["title"], eager=True)}</div>' if has_img(about.get("image")) else ""
    write("about/index.html", page(about["title"], about["description"], "/about/",
          f'<article class="post"><h1 class="page-title">{esc(about["title"])}</h1>{cover}<div class="prose">{md_to_html(about["body"])}</div></article>'))

    # 學員回饋
    fb_main = ('<article class="post"><h1 class="page-title">學員回饋</h1>'
        '<p class="lead">如果你上過我的課，很歡迎留下幾句話。你填的內容我會先看過，經過你同意才會公開在網站上，只顯示你填的稱呼。</p>'
        f'<div class="form-wrap"><iframe src="{FEEDBACK_FORM}" title="學員回饋表單" loading="lazy">載入中…</iframe></div>'
        f'<p class="form-alt">表單沒有顯示的話，可以<a href="{FEEDBACK_FORM.replace("?embedded=true", "")}" target="_blank" rel="noopener">在新分頁開啟</a>。</p></article>')
    write("feedback/index.html", page("學員回饋", "上過柔柔老師課程的學員，歡迎在這裡留下回饋。", "/feedback/", fb_main))

    # 404
    write("404.html", page("找不到頁面", "找不到這個頁面。", "/404.html",
          '<section class="sec first"><h1 class="page-title">找不到這個頁面</h1><p>網址可能打錯了，或文章已經移動。<a href="/">回首頁</a></p></section>'))

    # 搜尋引擎檔案
    newest = posts[0]["date"] if posts else None
    urls = [("/", newest), ("/posts/", newest), ("/about/", None), ("/feedback/", None)]
    urls += [(f'/category/{c["slug"]}/', None) for c in used]
    urls += [(f'/series/{s["slug"]}/', None) for s in used_series]
    urls += [(f'/posts/{p["slug"]}/', p["date"]) for p in posts]
    sm = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for path, d in urls:
        sm.append(f"<url><loc>{SITE_URL}{path}</loc>" + (f"<lastmod>{d}</lastmod>" if d else "") + "</url>")
    sm.append("</urlset>")
    write("sitemap.xml", "\n".join(sm) + "\n")
    write("robots.txt", f"User-agent: *\nAllow: /\n\nSitemap: {SITE_URL}/sitemap.xml\n")
    print(f"完成：{len(posts)} 篇文章，輸出到 {OUT}")


if __name__ == "__main__":
    main()
