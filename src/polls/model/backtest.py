"""Backtest the CLR-weighted poll aggregation against known election
results: run aggregate_as_of() using only polls available before each past
election, compare to the actual province-wide outcome.
"""

from __future__ import annotations

from datetime import date

import duckdb
import pandas as pd

from polls.model.compositional import aggregate_as_of, load_poll_composition

# (election_date, half_life_days) -- shorter half-life in the final campaign
# stretch, per qc125's own stated methodology.
QC_ELECTIONS = [
    (date(2018, 10, 1), 10),
    (date(2022, 10, 3), 10),
]


def actual_province_result(con: duckdb.DuckDBPyConnection, election_date: date, jurisdiction_code: str = "qc-provincial") -> dict[str, float]:
    df = con.execute(
        """
        SELECT party_code, sum(votes) AS votes
        FROM election_results
        WHERE jurisdiction_code = ? AND election_date = ? AND boundary_year = '2017' AND riding_code IS NOT NULL
        GROUP BY party_code
        """,
        [jurisdiction_code, election_date],
    ).df()
    df["party_code"] = df["party_code"].apply(lambda p: p if p in ("CAQ", "LIB", "QS", "PQ", "PCQ") else "AUTRES")
    df = df.groupby("party_code")["votes"].sum()
    return (df / df.sum()).to_dict()


def run_backtest(con: duckdb.DuckDBPyConnection) -> pd.DataFrame:
    wide, parties = load_poll_composition(con, "qc-provincial", "National")
    rows = []
    for election_date, half_life in QC_ELECTIONS:
        est = aggregate_as_of(wide, parties, election_date, half_life_days=half_life, lookback_days=90)
        actual = actual_province_result(con, election_date)
        for party in parties:
            rows.append(
                {
                    "election_date": election_date,
                    "party_code": party,
                    "estimated": est.get(party, 0.0) if est else None,
                    "actual": actual.get(party, 0.0),
                }
            )
    df = pd.DataFrame(rows)
    df["error_pp"] = (df["estimated"] - df["actual"]) * 100
    return df


if __name__ == "__main__":
    con = duckdb.connect("data/polls.duckdb")
    result = run_backtest(con)
    pd.set_option("display.float_format", lambda x: f"{x:.3f}")
    print(result.to_string(index=False))
    print("\nMean absolute error (pp):", result["error_pp"].abs().mean())
