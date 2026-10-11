"""Builds the offline index of the Real Logistics "Biểu thuế XNK" workbook (an UNOFFICIAL compilation of the official
tariff decrees) for the tariff_vn_table tool (.opencode/tools/tariff.ts).

Usage:  .sandbox/eval/venv/bin/python -I tools/ingest-vn-tariff-table.py <workbook.xlsx> <out-dir> <version-date>
        (needs openpyxl). Example:
        ... tools/ingest-vn-tariff-table.py .sandbox/data/tariff-reallogistics/2026-04-05/btxnk-2026.xlsx \
            .sandbox/data/tariff-reallogistics/index 2026-04-05

Output: { meta, codes: { "09012111": { desc_vi, desc_en, unit, rates: { KEY: {v, doc, from} }, policy, rcep: {...},
          years: { EVFTA: { "2026": "0", ... }, ... } } } }
The workbook is read only as data (read_only, data_only): no macros, no formulas evaluated.
"""
import json
import re
import sys

import openpyxl

SRC, OUT, VERSION = sys.argv[1], sys.argv[2], sys.argv[3]
wb = openpyxl.load_workbook(SRC, read_only=True, data_only=True)

def s(v):
    if v is None:
        return ""
    if hasattr(v, "strftime"):
        return v.strftime("%d/%m/%Y")
    return str(v).strip()

# ---- main sheet: one row per 8-digit code ----------------------------------------------------------------------
ws = wb["BT2026"]
rows = ws.iter_rows(values_only=True)
header = None
for i, r in enumerate(rows):
    if i == 2:
        header = [s(h).replace("\n", " ") for h in r]
        break
# rate columns: a rate header followed by "Văn bản", "Ngày hiệu lực"
LABEL = {"NK TT": "NK_THONG_THUONG", "NK ưu đãi": "NK_UU_DAI", "VAT": "VAT", "TT ĐB": "TTDB", "XK": "XK", "XK CP TPP": "XK_CPTPP",
         "XK EV": "XK_EVFTA", "XK UKV": "XK_UKVFTA", "Thuế BV MT": "BVMT"}
rate_cols = []
for j, h in enumerate(header):
    if h and h not in ("Văn bản", "Ngày hiệu lực") and j + 2 < len(header) and header[j + 1] == "Văn bản" and header[j + 2] == "Ngày hiệu lực":
        rate_cols.append((LABEL.get(h, h.replace(" ", "")), j))
RCEP_COL = header.index("RCEPT")
RCEP_PARTNERS = ["ASEAN", "Australia", "Trung Quốc", "Nhật Bản", "Hàn Quốc", "New Zealand"]  # Phụ lục A–F, NĐ 129/2022/NĐ-CP
POLICY_COL = next(j for j, h in enumerate(header) if h.startswith("Chính sách mặt hàng"))
codes = {}
heading = ""
for r in ws.iter_rows(min_row=9, values_only=True):
    code = re.sub(r"\D", "", s(r[5]))
    desc = s(r[6])
    if len(code) == 4:
        heading = desc
    if len(code) != 8:
        continue
    rec = {"desc_vi": desc, "desc_en": s(r[7]), "unit": s(r[8]), "heading": heading, "rates": {}}
    for key, j in rate_cols:
        v, doc, frm = s(r[j]), s(r[j + 1]), s(r[j + 2])
        if v or doc:
            rec["rates"][key] = {"v": v, "doc": doc, "from": frm}
    rcep = {p: s(r[RCEP_COL + k]) for k, p in enumerate(RCEP_PARTNERS) if s(r[RCEP_COL + k])}
    if rcep:
        rec["rates"]["RCEP"] = {"v": "; ".join(f"{p}: {v}" for p, v in rcep.items()), "doc": s(r[RCEP_COL + 6]), "from": s(r[RCEP_COL + 7]), "by_partner": rcep}
    if s(r[POLICY_COL]):
        rec["policy"] = s(r[POLICY_COL])
    codes[code] = rec

# ---- FTA sheets with a year-by-year schedule (header row with 2022 … 2027) -------------------------------------
YEAR_SHEETS = {}
for name in wb.sheetnames:
    if name in ("BT2026", "BIA", "HT", "BANG", "6QT", "PL1", "PL2", "EU", "MOI", "CU", "DB", "MT"):
        continue
    ws = wb[name]
    title, year_cols, code_col, label = "", None, None, name
    for i, r in enumerate(ws.iter_rows(min_row=1, max_row=12, values_only=True)):
        vals = [s(v) for v in r]
        title += " " + " ".join(v for v in vals if v)
        ys = {j: v for j, v in enumerate(vals) if re.fullmatch(r"20(2\d|3\d)", v)}
        if len(ys) >= 3:
            year_cols = ys
        for j, v in enumerate(vals):
            if re.match(r"^Mã (hàng|HS)", v):
                code_col = j
    if not year_cols or code_col is None:
        continue
    m = re.search(r"Thuế suất ([A-Z][A-Za-z-]+)", title)
    fta = m.group(1) if m else name
    if name in ("A", "B", "C", "D", "E", "F") or name.startswith("RCEPT"):
        part = {"RCEPT-A": "ASEAN", "B": "Australia", "C": "Trung Quốc", "D": "Nhật Bản", "E": "Hàn Quốc", "F": "New Zealand"}.get(name, name)
        fta = f"RCEP ({part})"
    fta = {"UKV": "UKVFTA", "UKV-XK": "UKVFTA"}.get(fta, fta)
    if name.endswith("-XK"):
        fta = f"{fta} xuất khẩu"
    doc = re.search(r"(\d{1,3}/20\d\d/NĐ-CP)", title)
    YEAR_SHEETS[name] = {"fta": fta, "doc": doc.group(1) if doc else ""}
    n = 0
    for r in ws.iter_rows(min_row=1, values_only=True):
        code = re.sub(r"\D", "", s(r[code_col]) if code_col < len(r) else "")
        if len(code) != 8 or code not in codes:
            continue
        sched = {y: s(r[j]) for j, y in year_cols.items() if j < len(r) and s(r[j]) != ""}
        if sched:
            codes[code].setdefault("years", {})[fta] = {"doc": YEAR_SHEETS[name]["doc"], "rates": sched}
            n += 1
    YEAR_SHEETS[name]["codes"] = n

# ---- version notes (sheet HT): which decree each table follows ---------------------------------------------------
notes = []
for r in wb["HT"].iter_rows(min_row=6, values_only=True):
    vals = [s(v).replace("\n", " ") for v in r]
    if len(vals) > 5 and vals[1] and vals[2] and vals[5]:
        notes.append({"table": vals[2], "short": vals[3], "docs": vals[5], "issued": vals[6], "effective": vals[7], "replaces": vals[8], "note": vals[10] if len(vals) > 10 else ""})

meta = {
    "source": "Real Logistics – Biểu thuế xuất nhập khẩu 2026 (bảng tổng hợp KHÔNG CHÍNH THỨC từ các văn bản pháp luật)",
    "page": "https://reallogistics.vn/vi/cap-nhat-thi-truong/bieu-thue-xuat-nhap-khau-2026-file-tra-cuu-day-du-cap-nhat-moi-nhat",
    "version": VERSION,
    "codes": len(codes),
    "with_policy": sum(1 for c in codes.values() if c.get("policy")),
    "year_tables": YEAR_SHEETS,
    "tables": notes,
}
# OUT is a directory: meta.json, search.json (code → short description, for lookups by name) and one file per
# HS chapter (01.json … 97.json) so the tool loads only the chapter it needs.
import os
os.makedirs(OUT, exist_ok=True)
with open(os.path.join(OUT, "meta.json"), "w", encoding="utf-8") as f:
    json.dump(meta, f, ensure_ascii=False)
with open(os.path.join(OUT, "search.json"), "w", encoding="utf-8") as f:
    json.dump({c: f"{r['heading'][:120]} › {r['desc_vi'].lstrip('- ')[:160]}" for c, r in codes.items()}, f, ensure_ascii=False)
by_ch = {}
for c, r in codes.items():
    by_ch.setdefault(c[:2], {})[c] = r
for ch, part in by_ch.items():
    with open(os.path.join(OUT, f"{ch}.json"), "w", encoding="utf-8") as f:
        json.dump(part, f, ensure_ascii=False)
print(json.dumps({k: v for k, v in meta.items() if k != "tables"}, ensure_ascii=False)[:1500])
