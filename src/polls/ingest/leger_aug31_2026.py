"""One-off loader: Léger/Le Journal/TVA poll, field 2026-08-28 to 31, n=1,008.

Source: data/raw/Rapport-intentions-de-vote-31-aout-2026-VF.pdf (rapport
Léger du 31 août 2026, projet 10016937).

National decided (après répartition, n=882): PQ 29, CAQ 24, PLQ 22, PCQ 15,
QS 10, autres 0. Third consecutive CAQ uptick (20 -> 23 -> 24 in Léger's own
series) -- the post-Fréchette recovery continues.

Loaded twice over, same convention as synopsis_aug2026:
  - the NATIONAL row, ahead of Wikipedia. The watch's wholesale reload of the
    National series will replace it with Wikipedia's version of the same poll
    once their table carries it; convergence is automatic.
  - the REGIONAL rows (page 7 crosstab, decided voters). Léger's split maps
    one-to-one onto this project's regions: MTL RMR -> MTL, QC RMR -> QC,
    Reste du Québec -> REG. No île/couronne recombination needed here (the
    report does not separate them). These survive watch runs (the reload
    only touches National).
"""

from __future__ import annotations

import hashlib
from datetime import date, datetime
from pathlib import Path

import duckdb

FIRM = "Léger"
FIELD_END = date(2026, 8, 31)
SOURCE = "data/raw/Rapport-intentions-de-vote-31-aout-2026-VF.pdf (Léger/Le Journal/TVA, terrain 28-31 août 2026)"

NATIONAL = {"n": 1008, "shares": {"PQ": 29, "CAQ": 24, "LIB": 22, "PCQ": 15, "QS": 10, "AUTRES": 0}}

# Decided voters by RMR (page 7): n = 364 + 268 + 250 = 882.
REGIONAL = {
    "MTL": {"n": 364, "shares": {"PQ": 27, "CAQ": 23, "LIB": 30, "PCQ": 9, "QS": 10, "AUTRES": 0}},
    "QC": {"n": 268, "shares": {"PQ": 24, "CAQ": 26, "LIB": 12, "PCQ": 30, "QS": 8, "AUTRES": 0}},
    "REG": {"n": 250, "shares": {"PQ": 32, "CAQ": 25, "LIB": 13, "PCQ": 19, "QS": 10, "AUTRES": 0}},
}


def _poll_id(region: str, n: int) -> str:
    key = f"qc-provincial|{region}|{FIRM}|{FIELD_END.isoformat()}|{n}"
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]


def main() -> None:
    con = duckdb.connect(str(Path(__file__).parents[3] / "data" / "polls.duckdb"))
    now = datetime.now()
    for region, payload in {"National": NATIONAL, **REGIONAL}.items():
        pid = _poll_id(region, payload["n"])
        con.execute("DELETE FROM poll_shares WHERE poll_id = ?", [pid])
        con.execute("DELETE FROM polls WHERE poll_id = ?", [pid])
        con.execute(
            "INSERT INTO polls VALUES (?, 'qc-provincial', ?, ?, ?, ?, false, NULL, NULL, ?, ?)",
            [pid, region, FIRM, FIELD_END, payload["n"], SOURCE, now],
        )
        for party, pct in payload["shares"].items():
            con.execute("INSERT INTO poll_shares VALUES (?, ?, ?)", [pid, party, float(pct)])
        print(f"  {region}: n={payload['n']}, {payload['shares']}")
    con.close()


if __name__ == "__main__":
    main()
