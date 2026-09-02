"""One-off loader: Léger's cumulative regional report of 2026-08-25.

Source: "Grand sondage régional Léger - juin à août 2026.pdf" (data/raw/),
Léger/Le Journal/TVA, 11 polls cumulated 2026-06-12 -> 2026-08-24, n=11,305
(9,235 decided).

The NATIONAL numbers are deliberately NOT loaded. This report is a
cumulation of eleven polls that are individually in the database already
(Léger June 15, Aug 9, Aug 24, ...): adding the cumulation as a twelfth poll
would count the same respondents twice, with a sqrt(11305) weight that would
dominate the GP. A cumulation of already-ingested polls is not a new
observation of public opinion.

The REGIONAL breakdowns are a different matter: no individual poll in the
database carries them, the model's regional machinery (MTL/QC/REG) has no
current-cycle vote-intention data at all, and at n=1,800-3,700 per RMR these
are the best regional reads of the cycle. They are stored under the region
codes the schema already uses. Nothing downstream consumes them yet; they
are stored so the regional-swing work (TODO) has real data when it happens.

Numbers hand-transcribed from pages 7-9 of the PDF (decided voters):
  MTL RMR (n=3,713 weighted base col.): PLQ 32, PQ 25, CAQ 21, PCQ 13, QS 8
  QC RMR  (n=2,795): PQ 30, PCQ 30, CAQ 21, PLQ 13, QS 6
  Reste du Québec (n=2,727): PQ 36, CAQ 26, PCQ 17, PLQ 14, QS 6
"""

from __future__ import annotations

import hashlib
from datetime import date, datetime
from pathlib import Path

import duckdb

FIRM = "Léger"
FIELD_END = date(2026, 8, 24)
SOURCE = "data/raw/Grand sondage régional Léger - juin à août 2026.pdf (Léger/Le Journal/TVA, cumul 12 juin-24 août 2026)"

REGIONAL_ROWS = {
    "MTL": {"n": 3713, "shares": {"LIB": 32, "PQ": 25, "CAQ": 21, "PCQ": 13, "QS": 8, "AUTRES": 1}},
    "QC": {"n": 2795, "shares": {"PQ": 30, "PCQ": 30, "CAQ": 21, "LIB": 13, "QS": 6, "AUTRES": 0}},
    "REG": {"n": 2727, "shares": {"PQ": 36, "CAQ": 26, "PCQ": 17, "LIB": 14, "QS": 6, "AUTRES": 1}},
}


def _poll_id(region: str, n: int) -> str:
    key = f"qc-provincial|{region}|{FIRM}|{FIELD_END.isoformat()}|{n}"
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]


def main() -> None:
    con = duckdb.connect(str(Path(__file__).parents[3] / "data" / "polls.duckdb"))
    now = datetime.now()
    for region, payload in REGIONAL_ROWS.items():
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
