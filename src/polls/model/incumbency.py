"""Estimate an incumbency effect ("candidat sortant se représente") from the
2018 -> 2022 Quebec election (same riding map, so a clean within-map
comparison, and DGEQ's candidate-level bureau-vote data has candidate names
so we can tell "ran again" from "seat open" directly, not guess it).

Method: for each riding, take the 2018 winning party + winning candidate.
Check whether that same candidate appears on the 2022 ballot in the same
riding (name-matched, accent/case-insensitive). Compute that party's local
swing (2022 share - 2018 share) minus the party's province-wide swing over
the same period -- the "excess" swing this riding saw beyond what the
national trend alone would predict. The average excess swing for
"candidate ran again" ridings minus the average for "open seat" ridings is
the estimated incumbency premium: how much of a party's local over/under-
performance evaporates when the personal incumbent isn't on the ballot.

This is deliberately about the *candidate*, not the party: it answers "does
this specific person running again change the outcome", which is exactly
the qc125 methodology gap this was built to close (see TODO.md / the
Sherbrooke case). It says nothing about candidates who are more/less liked
than average (that would need the sentiment_signals proxy, not this).
"""

from __future__ import annotations

import unicodedata

import pandas as pd

from polls.ingest.dgeq_bureau_vote import parse_bv_results


def _normalize_name(name: str) -> str:
    name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    return name.lower().strip()


def _riding_party_shares(results: pd.DataFrame) -> pd.DataFrame:
    """One row per (riding, party): vote_share = party's share of that
    riding's total vote, from the "Total de la circonscription" rows."""
    totals = results[results["is_total_row"]].copy()
    riding_totals = totals.groupby("riding_name")["votes"].transform("sum")
    totals["vote_share"] = totals["votes"] / riding_totals
    return totals[["riding_name", "party_code", "candidate_name", "votes", "vote_share"]]


def _province_swing_by_party(shares_2018: pd.DataFrame, shares_2022: pd.DataFrame) -> dict[str, float]:
    prov_2018 = shares_2018.groupby("party_code")["votes"].sum()
    prov_2022 = shares_2022.groupby("party_code")["votes"].sum()
    share_2018 = prov_2018 / prov_2018.sum()
    share_2022 = prov_2022 / prov_2022.sum()
    return (share_2022 - share_2018).fillna(0).to_dict()


def build_incumbency_dataset(bv_2018_path, bv_2022_path) -> pd.DataFrame:
    results_2018 = parse_bv_results(bv_2018_path)
    results_2022 = parse_bv_results(bv_2022_path)

    shares_2018 = _riding_party_shares(results_2018)
    shares_2022 = _riding_party_shares(results_2022)
    province_swing = _province_swing_by_party(shares_2018, shares_2022)

    candidates_2022_by_riding: dict[str, set[str]] = {
        riding: set(group["candidate_name"].map(_normalize_name))
        for riding, group in shares_2022.groupby("riding_name")
    }

    winners_2018 = shares_2018.loc[shares_2018.groupby("riding_name")["votes"].idxmax()]

    rows = []
    for _, winner in winners_2018.iterrows():
        riding = winner["riding_name"]
        party = winner["party_code"]
        if riding not in candidates_2022_by_riding:
            continue
        share_2022_row = shares_2022[(shares_2022["riding_name"] == riding) & (shares_2022["party_code"] == party)]
        if share_2022_row.empty:
            continue  # party didn't field anyone at all in 2022 -- exclude, not an incumbency question

        ran_again = _normalize_name(winner["candidate_name"]) in candidates_2022_by_riding[riding]
        local_swing = share_2022_row["vote_share"].iloc[0] - winner["vote_share"]
        excess_swing = local_swing - province_swing.get(party, 0.0)

        rows.append(
            {
                "riding_name": riding,
                "party_code": party,
                "candidate_name": winner["candidate_name"],
                "ran_again": ran_again,
                "share_2018": winner["vote_share"],
                "share_2022": share_2022_row["vote_share"].iloc[0],
                "province_swing": province_swing.get(party, 0.0),
                "excess_swing": excess_swing,
            }
        )
    return pd.DataFrame(rows)


def estimate_incumbency_effect(dataset: pd.DataFrame) -> dict:
    ran_again = dataset[dataset["ran_again"]]["excess_swing"]
    open_seat = dataset[~dataset["ran_again"]]["excess_swing"]
    effect = ran_again.mean() - open_seat.mean()
    return {
        "n_ran_again": len(ran_again),
        "n_open_seat": len(open_seat),
        "mean_excess_swing_ran_again": ran_again.mean(),
        "mean_excess_swing_open_seat": open_seat.mean(),
        "incumbency_effect_pp": effect * 100,
    }


if __name__ == "__main__":
    from pathlib import Path

    raw_dir = Path("data/raw")
    dataset = build_incumbency_dataset(raw_dir / "dgeq_bv_2018-10-01.zip", raw_dir / "dgeq_bv_2022-10-03.zip")
    print(dataset.sort_values("excess_swing").to_string())
    print()
    print(estimate_incumbency_effect(dataset))
