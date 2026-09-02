-- Schema for the polls aggregation / seat-projection project.
-- Poll shares are stored long-form (one row per poll x party) so that the
-- "autres/undecided-adjusted" remainder can be carried as an explicit part,
-- keeping every poll a closed composition suitable for CLR/ILR analysis.

CREATE TABLE IF NOT EXISTS jurisdictions (
    jurisdiction_code   VARCHAR PRIMARY KEY,   -- 'qc-provincial', 'ca-federal'
    label               VARCHAR NOT NULL,
    source_site         VARCHAR NOT NULL       -- 'qc125.com', '338canada.com'
);

CREATE TABLE IF NOT EXISTS regions (
    jurisdiction_code   VARCHAR NOT NULL REFERENCES jurisdictions(jurisdiction_code),
    region_code         VARCHAR NOT NULL,      -- 'National', 'MTL', 'QC', 'REG', ...
    region_label        VARCHAR NOT NULL,
    PRIMARY KEY (jurisdiction_code, region_code)
);

CREATE TABLE IF NOT EXISTS parties (
    jurisdiction_code   VARCHAR NOT NULL REFERENCES jurisdictions(jurisdiction_code),
    party_code          VARCHAR NOT NULL,      -- 'CAQ', 'PLQ', 'LPC', ...
    party_label         VARCHAR,
    display_order       INTEGER NOT NULL,
    PRIMARY KEY (jurisdiction_code, party_code)
);

-- One row per poll (firm x date x region), independent of party breakdown.
CREATE TABLE IF NOT EXISTS polls (
    poll_id             VARCHAR PRIMARY KEY,   -- hash(jurisdiction, region, firm, date, sample)
    jurisdiction_code   VARCHAR NOT NULL REFERENCES jurisdictions(jurisdiction_code),
    region_code         VARCHAR NOT NULL,
    firm                VARCHAR NOT NULL,
    poll_date           DATE NOT NULL,         -- end of field date, as published
    sample_size         INTEGER,
    is_rolling          BOOLEAN DEFAULT FALSE,
    firm_rating         VARCHAR,               -- editorial house rating ('A+', 'NC', ...)
    general_election    VARCHAR,               -- non-empty when the row IS a ballot result, not a poll
    source_url          VARCHAR,
    scraped_at          TIMESTAMP NOT NULL
);

-- Long-form shares: one row per poll x party. pct_reported is the number as
-- published (already excludes undecided in these sources); pct_closed is
-- renormalized so all parties + 'AUTRES' sum to 1.0 per poll.
CREATE TABLE IF NOT EXISTS poll_shares (
    poll_id             VARCHAR NOT NULL REFERENCES polls(poll_id),
    party_code          VARCHAR NOT NULL,      -- includes synthetic 'AUTRES' remainder row
    pct_reported        DOUBLE,
    PRIMARY KEY (poll_id, party_code)
);

-- Past election results, needed both as model anchor points and for
-- backtesting the aggregation/projection algorithm.
--
-- boundary_year identifies which riding map riding_code refers to (e.g.
-- '2017' for the map used in the 2018/2022 QC elections, '2026' for the
-- next one). The same election can appear more than once under different
-- boundary_year values: once as originally reported, and again
-- areally-reprojected onto a later map (see ingest/dgeq_bureau_vote.py) --
-- that's how the pipeline stays usable across a redistricting instead of
-- riding_code silently meaning different things for different rows.
CREATE TABLE IF NOT EXISTS election_results (
    jurisdiction_code   VARCHAR NOT NULL,
    election_date       DATE NOT NULL,
    boundary_year       VARCHAR NOT NULL,
    riding_code         VARCHAR,               -- NULL for province/country-wide row
    party_code          VARCHAR NOT NULL,
    votes               DOUBLE,                -- DOUBLE: areally-reprojected rows carry fractional votes
    vote_share          DOUBLE,
    seat_won            BOOLEAN,
    PRIMARY KEY (jurisdiction_code, election_date, boundary_year, riding_code, party_code)
);

-- Riding-level demographics from StatCan census, aggregated from dissemination
-- areas to riding boundaries (see ingest/statcan.py). Kept wide because these
-- are covariates for the swing/regression model, not a composition.
--
-- boundary_year: same convention as election_results.boundary_year -- which
-- riding map riding_code is expressed on.
CREATE TABLE IF NOT EXISTS riding_demographics (
    jurisdiction_code       VARCHAR NOT NULL,
    boundary_year           VARCHAR NOT NULL,
    riding_code             VARCHAR NOT NULL,
    census_year             INTEGER NOT NULL,
    pct_french_home_lang    DOUBLE,
    pct_english_home_lang   DOUBLE,
    pct_allophone_home_lang DOUBLE,
    median_age              DOUBLE,
    median_household_income DOUBLE,
    pct_university_degree   DOUBLE,
    pct_immigrant           DOUBLE,
    population_density      DOUBLE,
    pct_urban               DOUBLE,
    -- Cultural diversity, education floor, and economic structure (NAICS
    -- sector shares of the labour force). See ingest/statcan.py's
    -- CHARACTERISTICS for the census characteristic each maps to.
    pct_visible_minority    DOUBLE,
    pct_no_diploma          DOUBLE,
    pct_ind_agriculture     DOUBLE,
    pct_ind_manufacturing   DOUBLE,
    pct_ind_retail          DOUBLE,
    pct_ind_professional    DOUBLE,
    pct_ind_health_social   DOUBLE,
    PRIMARY KEY (jurisdiction_code, boundary_year, riding_code, census_year)
);

-- Sitting members and their CURRENT party, which can differ from the party
-- that won the seat at the last election (floor crossings, expulsions,
-- resignations). See ingest/incumbents.py: a riding whose member now sits as
-- an independent has no incumbency premium left for the party that won it.
CREATE TABLE IF NOT EXISTS incumbents (
    jurisdiction_code   VARCHAR NOT NULL,
    riding_name         VARCHAR NOT NULL,
    member_name         VARCHAR,
    current_party       VARCHAR,          -- party_code, or 'IND'/'VACANT'
    elected_with_note   VARCHAR,          -- e.g. "Élu avec la CAQ", when the member changed affiliation
    scraped_at          TIMESTAMP NOT NULL,
    PRIMARY KEY (jurisdiction_code, riding_name)
);

-- Party leaders and the riding they CONTEST at the coming election -- not
-- the seat they currently hold. The two differ for a leader with no seat, and
-- for one switching ridings; both are projectable, and treating "holds no
-- seat" as "cannot be projected" was a real bug.
--
-- riding_source records how it was determined: 'annonce' for a confirmed
-- candidacy, 'siege actuel' for the assumption that a sitting leader runs
-- again where they sit. NULL riding means no announcement and no seat, which
-- is an unknown rather than an impossibility.
CREATE TABLE IF NOT EXISTS party_leaders (
    jurisdiction_code   VARCHAR NOT NULL,
    party_code          VARCHAR NOT NULL,
    leader_name         VARCHAR NOT NULL,
    riding_name         VARCHAR,
    riding_source       VARCHAR,
    scraped_at          TIMESTAMP NOT NULL,
    PRIMARY KEY (jurisdiction_code, party_code)
);

-- Reputation / attention proxy signals (Wikipedia pageviews, GDELT tone),
-- sourced and reproducible rather than a manual editorial judgement.
CREATE TABLE IF NOT EXISTS sentiment_signals (
    jurisdiction_code   VARCHAR NOT NULL,
    entity_type         VARCHAR NOT NULL,      -- 'party' | 'candidate'
    entity_code         VARCHAR NOT NULL,      -- party_code or 'riding_code:wikidata_id'
    signal_date         DATE NOT NULL,
    source              VARCHAR NOT NULL,      -- 'wikipedia_pageviews' | 'gdelt_gkg_tone'
    metric              VARCHAR NOT NULL,      -- 'pageviews' | 'avg_tone' | 'tone_stddev'
    value                DOUBLE,
    PRIMARY KEY (jurisdiction_code, entity_type, entity_code, signal_date, source, metric)
);
