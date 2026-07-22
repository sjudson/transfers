#!/usr/bin/env python3
"""Export the ManGame database (.xlsm) into the compact JSON snapshots the
extension bundles: extension/data/riders.json and extension/data/teams.json.

Usage:
    python3 -m venv .venv && .venv/bin/pip install openpyxl
    .venv/bin/python tools/export_db.py "2026DB_Transfers.xlsm"

Rider IDs (CyclistID) are the stable identifiers used throughout the tool, so a
new database drop keeps working as long as IDs are preserved.
"""
import sys, os, json, collections
import openpyxl

SRC = sys.argv[1] if len(sys.argv) > 1 else "2026DB_Transfers.xlsm"
OUT = os.path.join(os.path.dirname(__file__), "..", "extension", "data")

# Column indexes in the DYN_cyclist sheet (0-based).
C = dict(id=0, last=1, first=2, team=17, div=19, country=20,
         xl=22, xp=23, age=27, pot=28, ovl=29, wage=30, junior=35, onloan=47)

def main():
    wb = openpyxl.load_workbook(SRC, read_only=True, data_only=True)
    ws = wb["DYN_cyclist"]
    riders, teams = [], collections.Counter()
    for r in ws.iter_rows(min_row=2, values_only=True):
        if r[C["id"]] is None:
            continue
        team = (r[C["team"]] or "").strip()
        fa = team == "Free Agent"
        name = f"{(r[C['first']] or '').strip()} {(r[C['last']] or '').strip()}".strip()
        riders.append({
            "id": int(r[C["id"]]),
            "n": name,
            "t": "" if fa else team,
            "fa": 1 if fa else 0,
            "d": (r[C["div"]] or "").strip(),
            "w": int(r[C["wage"]]) if r[C["wage"]] is not None else 0,
            "xl": r[C["xl"]], "xp": r[C["xp"]],
            "a": r[C["age"]],
            "p": r[C["pot"]],
            "o": round(r[C["ovl"]], 1) if isinstance(r[C["ovl"]], (int, float)) else None,
            "c": (r[C["country"]] or "").strip(),
            "loan": 1 if r[C["onloan"]] else 0,
            "j": 1 if r[C["junior"]] else 0,
        })
        if not fa:
            teams[team] += 1
    riders.sort(key=lambda x: x["id"])
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "riders.json"), "w", encoding="utf-8") as f:
        json.dump({"generatedFrom": os.path.basename(SRC), "count": len(riders),
                   "riders": riders}, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(OUT, "teams.json"), "w", encoding="utf-8") as f:
        json.dump({"teams": sorted(teams)}, f, ensure_ascii=False, indent=0)
    print(f"{len(riders)} riders ({sum(r['fa'] for r in riders)} free agents), "
          f"{len(teams)} teams -> extension/data/")

if __name__ == "__main__":
    main()
