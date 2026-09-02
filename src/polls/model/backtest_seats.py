"""Backtest the thing the model actually outputs: riding-level winners and
the seat count, not just the province-wide vote share.

Setup: pretend it's the day before the 2022 election. Use the 2018 riding
results as the baseline, polls up to that cutoff for the province/region
trend, swing forward, and compare the projected winner in each riding
against what actually happened.

Deliberately EXCLUDED from this backtest, per the leak audit in TODO.md:
  - the incumbency / open-seat adjustment (+4.26pp), estimated ON the
    2018->2022 transition
  - the PCQ momentum slope (2.485), estimated partly on that same transition
Including either would be scoring the model on data used to fit it. That
means this backtest measures the *core* swing model only, which is the
honest thing it can measure.

Baselines to beat, both of which are what a person would do without any
model at all:
  - "no change": predict every riding's 2018 winner holds
  - "province-wide uniform": the same national swing everywhere (this IS the
    core model, so comparing it to the regional variant isolates what the
    regional split buys)
"""

from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

from polls.ingest.riding_regions import build_riding_region_map
from polls.model.compositional import aggregate_as_of, campaign_half_life, load_poll_composition
from polls.model.swing import regional_clr_swing, uniform_clr_swing

PARTIES = ["CAQ", "LIB", "QS", "PQ", "PCQ", "AUTRES"]


def _normalize(code) -> str:
    return str(int(float(code)))


def riding_shares(con: duckdb.DuckDBPyConnection, election_date: str, boundary_year: str = "2026") -> pd.DataFrame:
    df = con.execute(
        """
        SELECT riding_code, party_code, sum(votes) AS votes
        FROM election_results
        WHERE jurisdiction_code='qc-provincial' AND boundary_year=? AND election_date=?
          AND riding_code IS NOT NULL
        GROUP BY 1,2
        """,
        [boundary_year, election_date],
    ).df()
    df["riding_code"] = df["riding_code"].apply(_normalize)
    df["party_code"] = df["party_code"].apply(lambda p: p if p in PARTIES else "AUTRES")
    df = df.groupby(["riding_code", "party_code"])["votes"].sum().reset_index()
    wide = df.pivot_table(index="riding_code", columns="party_code", values="votes", fill_value=0.0)
    for p in PARTIES:
        if p not in wide.columns:
            wide[p] = 0.0
    return wide[PARTIES].div(wide[PARTIES].sum(axis=1), axis=0)


def region_aggregate(shares: pd.DataFrame, region: pd.Series, weights: pd.Series) -> dict[str, dict[str, float]]:
    """Vote-weighted party shares per region (weights = each riding's total
    votes, so a big riding counts more than a small one)."""
    out = {}
    for reg, group in shares.groupby(region):
        w = weights.reindex(group.index).fillna(0)
        totals = (group[PARTIES].mul(w, axis=0)).sum()
        out[reg] = (totals / totals.sum()).to_dict()
    return out


def run(con: duckdb.DuckDBPyConnection, raw_dir: Path) -> dict:
    baseline = riding_shares(con, "2018-10-01")
    actual = riding_shares(con, "2022-10-03")
    common = baseline.index.intersection(actual.index)
    baseline, actual = baseline.loc[common], actual.loc[common]

    region_map = build_riding_region_map(raw_dir).set_index("riding_code")["region_code"]
    region = pd.Series({c: region_map.get(c, "REG") for c in common})

    votes_2018 = con.execute(
        """
        SELECT riding_code, sum(votes) AS total FROM election_results
        WHERE jurisdiction_code='qc-provincial' AND boundary_year='2026' AND election_date='2018-10-01'
        GROUP BY 1
        """
    ).df()
    votes_2018["riding_code"] = votes_2018["riding_code"].apply(_normalize)
    weights = votes_2018.set_index("riding_code")["total"]

    as_of = date(2022, 10, 3) - timedelta(days=1)
    half_life = campaign_half_life(as_of, date(2022, 10, 3))

    nat_wide, _ = load_poll_composition(con, "qc-provincial", "National")
    province_forecast = aggregate_as_of(nat_wide, PARTIES, as_of, half_life_days=half_life, lookback_days=90)
    province_baseline = region_aggregate(baseline, pd.Series("ALL", index=common), weights)["ALL"]

    region_baseline = region_aggregate(baseline, region, weights)
    region_forecast = {}
    for reg in ["MTL", "QC", "REG"]:
        reg_wide, _ = load_poll_composition(con, "qc-provincial", reg)
        region_forecast[reg] = aggregate_as_of(reg_wide, PARTIES, as_of, half_life_days=half_life, lookback_days=90)

    actual_winner = actual[PARTIES].idxmax(axis=1)
    results = {}

    results["aucun changement (2018 tient)"] = baseline[PARTIES].idxmax(axis=1)
    results["swing uniforme"] = uniform_clr_swing(baseline, province_baseline, province_forecast, PARTIES)["projected_winner"]
    results["swing regional"] = regional_clr_swing(baseline, region, region_baseline, region_forecast, PARTIES)["projected_winner"]

    scored = {}
    for name, predicted in results.items():
        correct = (predicted == actual_winner).sum()
        seat_err = sum(
            abs((predicted == p).sum() - (actual_winner == p).sum()) for p in PARTIES
        )
        scored[name] = {
            "ridings_correct": int(correct),
            "ridings_total": len(common),
            "accuracy": correct / len(common),
            "total_seat_error": int(seat_err),
            "predicted_seats": {p: int((predicted == p).sum()) for p in PARTIES if (predicted == p).sum()},
        }
    scored["_actual_seats"] = {p: int((actual_winner == p).sum()) for p in PARTIES if (actual_winner == p).sum()}
    return scored


if __name__ == "__main__":
    import warnings

    warnings.filterwarnings("ignore")
    con = duckdb.connect("data/polls.duckdb")
    out = run(con, Path("data/raw"))
    actual_seats = out.pop("_actual_seats")

    print("Backtest 2022 : projection de sieges a partir de 2018 + sondages\n")
    print(f"Sieges reels 2022 : {actual_seats}\n")
    for name, s in sorted(out.items(), key=lambda kv: -kv[1]["accuracy"]):
        print(f"{name}")
        print(f"   circonscriptions correctes : {s['ridings_correct']}/{s['ridings_total']}  ({s['accuracy']*100:.1f}%)")
        print(f"   erreur totale de sieges    : {s['total_seat_error']}")
        print(f"   sieges projetes            : {s['predicted_seats']}")
        print()
    con.close()
