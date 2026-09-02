"""One-off loader: Synopsis/La Presse poll, field 2026-08-24 to 26, n=1,009.

Source: data/raw/synopsis_2026-08.pdf
(https://divers.lpcdn.ca/redact/lapresse/actualites/NOUVEAU%20sondage.pdf)

National decided (après répartition, n=867): PQ 28, CAQ 27, LIB 20, PCQ 14,
QS 10, autres 1. The CAQ jumps 7 points in three weeks -- the largest single
inter-poll move of the cycle.

Loaded twice over:
  - the NATIONAL row, ahead of Wikipedia. The watch's wholesale reload of
    the National series will drop this row and re-add Wikipedia's version of
    the same poll once their table carries it; a short double-entry window
    is impossible (delete happens in the same transaction as the reinsert),
    a short gap is possible if the row lands between Wikipedia edits. Both
    acceptable; convergence is automatic.
  - the REGIONAL rows, mapped to this project's regions: the report splits
    Île de Montréal from the rest of the Montreal RMR, so those two columns
    are combined (weighted by their decided-voter counts) into MTL; Québec
    RMR -> QC; Ailleurs au Québec -> REG. These feed the regional trend
    work and survive watch runs (the reload only touches National).
"""

from __future__ import annotations

import hashlib
from datetime import date, datetime
from pathlib import Path

import duckdb

FIRM = "Synopsis Recherche"
FIELD_END = date(2026, 8, 26)
SOURCE = "https://divers.lpcdn.ca/redact/lapresse/actualites/NOUVEAU%20sondage.pdf (Synopsis/La Presse, terrain 24-26 aout 2026)"

NATIONAL = {"n": 1009, "shares": {"PQ": 28, "CAQ": 27, "LIB": 20, "PCQ": 14, "QS": 10, "AUTRES": 1}}

# Decided voters by report region (page 6). Île (n=213) and RMR-hors-île
# (n=204) are combined into MTL with those counts as weights.
_ILE = {"PQ": 24, "CAQ": 15, "LIB": 34, "PCQ": 8, "QS": 17, "AUTRES": 2}
_RMR = {"PQ": 30, "CAQ": 32, "LIB": 18, "PCQ": 12, "QS": 7, "AUTRES": 1}
_W_ILE, _W_RMR = 213, 204

REGIONAL = {
    "MTL": {
        "n": _W_ILE + _W_RMR,
        "shares": {p: round((_ILE[p] * _W_ILE + _RMR[p] * _W_RMR) / (_W_ILE + _W_RMR), 1) for p in _ILE},
    },
    "QC": {"n": 155, "shares": {"CAQ": 36, "PQ": 28, "PCQ": 22, "LIB": 7, "QS": 6, "AUTRES": 1}},
    "REG": {"n": 295, "shares": {"PQ": 29, "CAQ": 28, "PCQ": 17, "LIB": 16, "QS": 8, "AUTRES": 1}},
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
