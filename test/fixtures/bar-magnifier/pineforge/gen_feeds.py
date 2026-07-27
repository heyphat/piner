#!/usr/bin/env python3
"""Deterministic M1 feeds for the Bar Magnifier parity probe.

Emits, per scenario:
  data/<name>.m1.csv       M1 bars                -> PineForge feed (input_tf=1)
  data/<name>.chart.csv    the chart-TF aggregation -> the non-magnifier view
  data/<name>.json         chart Bar[] + a BarMagnifierData payload -> piner injection

Every scenario shares one skeleton: 5 flat warmup chart bars, 1 arm bar (the
probe submits its entry + bracket at that close), 1 scenario bar carrying the
adversarial M1 path, then flat/settling tail bars. Orders become eligible on
the scenario bar, so the whole parity question is "what did the M1 path do
inside that one chart bar, and in what order".

No RNG, no clock: byte-identical on every run.
"""

import csv
import json
import os

MS_MIN = 60_000
# Chart TF is 10m because that is the ONLY band whose Bar Magnifier target is
# 1-minute: piner's barMagnifierTimeframe() maps 10m <= chart < 15m -> "1"
# (a 60m chart magnifies to 10m, not M1). This is the "M1" probe, so 10m it is.
CHART_TF = "10"
MS_CHART = 10 * MS_MIN
START_MS = 1_735_689_600_000  # 2025-01-01T00:00:00Z
BARS_PER_CHART = 10           # 10 x M1 per 10m chart bar
FLAT = 98.0

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")


def walk(points, n=BARS_PER_CHART):
    """Trace `points` (price waypoints) across n M1 bars.

    Each waypoint pair becomes a contiguous run of M1 bars moving linearly from
    one to the next; a bar's high/low are exactly its own open/close extremes,
    so no price outside a segment is ever "visited". A `("gap", p)` waypoint
    jumps discontinuously: the next bar OPENS at p, and nothing between the
    previous close and p is touched.
    """
    legs = []
    prev = points[0]
    for pt in points[1:]:
        if isinstance(pt, tuple) and pt[0] == "gap":
            legs.append(("gap", prev, pt[1]))
            prev = pt[1]
        else:
            legs.append(("move", prev, pt))
            prev = pt

    # Distribute the n bars over the legs; gap legs need exactly 1 bar.
    gap_legs = sum(1 for l in legs if l[0] == "gap")
    move_legs = len(legs) - gap_legs
    budget = n - gap_legs
    per = budget // move_legs if move_legs else 0
    extra = budget - per * move_legs if move_legs else 0

    bars = []
    for kind, a, b in legs:
        if kind == "gap":
            bars.append((b, b, b, b))  # opens at the far side of the gap
            continue
        k = per + (1 if extra > 0 else 0)
        if extra > 0:
            extra -= 1
        for i in range(k):
            o = a + (b - a) * (i / k)
            c = a + (b - a) * ((i + 1) / k)
            bars.append((o, max(o, c), min(o, c), c))
    assert len(bars) == n, (len(bars), n)
    return [tuple(round(x, 4) for x in bar) for bar in bars]


def flat_bar(level=FLAT, n=BARS_PER_CHART):
    """A quiet chart bar: a shallow ±0.1 breathe around `level`."""
    return walk([level, level + 0.1, level - 0.1, level], n)


def build(chart_paths):
    """chart_paths: one BARS_PER_CHART-long M1 OHLC list per chart bar."""
    m1 = []
    chart = []
    ts = START_MS
    for ci, sub in enumerate(chart_paths):
        for bi, (o, h, l, c) in enumerate(sub):
            m1.append(
                {
                    "timestamp": ts + ci * MS_CHART + bi * MS_MIN,
                    "open": o,
                    "high": h,
                    "low": l,
                    "close": c,
                    "volume": 1.0,
                }
            )
        chart.append(
            {
                "timestamp": ts + ci * MS_CHART,
                "open": sub[0][0],
                "high": round(max(b[1] for b in sub), 4),
                "low": round(min(b[2] for b in sub), 4),
                "close": sub[-1][3],
                "volume": float(len(sub)),
            }
        )
    return m1, chart


# --- scenarios ---------------------------------------------------------------
# Levels the probe uses by default: entry 100, stop 95, target 105 (long).
# Scenarios A and B are the load-bearing pair: IDENTICAL chart-bar OHLC,
# opposite intrabar ordering. Any engine that ignores the M1 path must return
# the same trade for both; a real magnifier must not.

WARMUP = [flat_bar() for _ in range(5)]  # chart bars 1..5
ARM = [flat_bar()]                       # chart bar 6 -> submit at close
TAIL_FLAT = [flat_bar() for _ in range(2)]

SCENARIOS = {
    # entry 100 -> target 105 hit BEFORE stop 95
    "A_tp_before_sl": {
        "inputs": {},
        "scenario_bar": walk([98.0, 100.5, 106.0, 94.0, 99.0]),
        "tail": TAIL_FLAT,
        "expect": "magnifier: exit at TP 105. whole-bar: chart bar is O98 H106 L94 C99, "
                  "same as scenario B, so a path-blind engine must answer identically for both.",
    },
    # entry 100 -> stop 95 hit BEFORE target 105. Same chart OHLC as A.
    "B_sl_before_tp": {
        "inputs": {},
        "scenario_bar": walk([98.0, 100.5, 94.0, 106.0, 99.0]),
        "tail": TAIL_FLAT,
        "expect": "magnifier: exit at SL 95. Chart OHLC identical to scenario A.",
    },
    # limit entry at 100: price prints the TP level BEFORE the entry fills, so
    # the bracket must NOT fill on the entry bar.
    "C_tp_touched_before_limit_entry": {
        "inputs": {"3. Entry order": "Limit"},
        "scenario_bar": walk([102.0, 106.0, 99.0, 101.0]),
        # settle: a later bar sinks to the stop so the trade closes deterministically
        "tail": [flat_bar(), walk([101.0, 94.0, 96.0])],
        "expect": "magnifier: no exit on the entry bar (105 printed pre-entry); trade closes "
                  "at SL 95 on the settling bar. whole-bar: entry 100 then H106 >= 105 -> TP same bar.",
    },
    # the entry stop is jumped over between two M1 bars: fill at the sub-bar
    # open, not at the stop level.
    "D_subbar_gap_entry": {
        "inputs": {},
        "scenario_bar": walk([98.0, 99.5, ("gap", 101.2), 103.0, 102.0]),
        "tail": [flat_bar(101.5), walk([101.5, 94.0, 96.0])],
        "expect": "magnifier: entry fills at the gapped sub-bar open 101.2. whole-bar: chart bar "
                  "opens 98 < 100 with H103, so a path-blind engine fills at the stop level 100.",
    },
    # short mirror of A: entry stop 96 downward, target 91, stop 101.
    "E_short_tp_before_sl": {
        "inputs": {
            "2. Direction": "Short",
            "5. Entry level": "96",
            "6. Stop-loss level": "101",
            "7. Take-profit level": "91",
        },
        "scenario_bar": walk([98.0, 95.5, 90.0, 102.0, 97.0]),
        "tail": TAIL_FLAT,
        "expect": "magnifier: short entry ~96 then TP 91 before SL 101.",
    },
}


def main():
    os.makedirs(OUT, exist_ok=True)
    index = {}
    for name, spec in SCENARIOS.items():
        paths = WARMUP + ARM + [spec["scenario_bar"]] + spec["tail"]
        # One extra quiet bar at the settled price so a force-close market order
        # issued on the last scenario bar always has a next bar open to fill at.
        paths = paths + [flat_bar(paths[-1][-1][3])]
        m1, chart = build(paths)

        for rows, suffix in ((m1, "m1"), (chart, "chart")):
            path = os.path.join(OUT, f"{name}.{suffix}.csv")
            with open(path, "w", newline="") as fh:
                w = csv.writer(fh)
                w.writerow(["timestamp", "open", "high", "low", "close", "volume"])
                for r in rows:
                    w.writerow(
                        [r["timestamp"], r["open"], r["high"], r["low"], r["close"], r["volume"]]
                    )

        # piner-side payload. `magnifier_data` is shaped as engine/feed.ts
        # `BarMagnifierData` so it can be injected verbatim once the P2
        # traversal consumes the buckets; `chart_bars` are `Bar[]`.
        chart_bars = [
            {"time": c["timestamp"], "open": c["open"], "high": c["high"],
             "low": c["low"], "close": c["close"], "volume": c["volume"]}
            for c in chart
        ]
        target_bars = [
            {"time": b["timestamp"], "open": b["open"], "high": b["high"],
             "low": b["low"], "close": b["close"], "volume": b["volume"]}
            for b in m1
        ]
        span = {"from": chart_bars[0]["time"], "to": chart_bars[-1]["time"] + MS_CHART}
        with open(os.path.join(OUT, f"{name}.json"), "w") as fh:
            json.dump(
                {
                    "scenario": name,
                    "expect": spec["expect"],
                    "inputs": spec["inputs"],
                    "chart_timeframe": CHART_TF,
                    "arm_chart_bar": 6,
                    "scenario_chart_bar": 7,
                    "chart_bars": chart_bars,
                    "magnifier_data": {
                        "targetTimeframe": "1",
                        "bars": target_bars,
                        "chartIntervals": {
                            "closeTimes": [c["time"] + MS_CHART for c in chart_bars],
                            "source": "utc-fixed",
                        },
                        "coverage": {
                            "requested": span,
                            "covered": [span],
                            "gaps": [],
                            "complete": True,
                        },
                    },
                },
                fh,
                indent=1,
            )

        sb = chart[6]
        index[name] = {
            "scenario_bar_ohlc": [sb["open"], sb["high"], sb["low"], sb["close"]],
            "inputs": spec["inputs"],
            "expect": spec["expect"],
        }
        print(f"{name}: {len(m1)} M1 / {len(chart)} chart bars; scenario bar "
              f"O{sb['open']} H{sb['high']} L{sb['low']} C{sb['close']}")

    with open(os.path.join(OUT, "index.json"), "w") as fh:
        json.dump(index, fh, indent=1)


if __name__ == "__main__":
    main()
