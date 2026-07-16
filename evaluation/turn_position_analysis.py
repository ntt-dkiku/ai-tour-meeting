#!/usr/bin/env python3
"""Turn-position (speaking-order) analysis on the round-robin rotation runs.

Reproduces the acceptance-rate results and the paper figure of the
"Turn rules" subsection:

  * proposal acceptance rate by speaking position (p1-p3), pooled over the
    three Latin-square seat rotations, split by whether the proposer had
    used the `ask` action at least once before the proposal (cumulative)
  * per-participant FIRST proposal acceptance (denominator-free variant)
  * effort: proposals made / accepted per meeting by position
  * robustness decompositions: excluding the meeting-opening proposal,
    by own-attempt index, by meeting phase, per-meeting equal weighting

Inputs (expected under --data-dir, committed in this repo):
  meetings_p3_n50_rot{0,1,2}_turncmp{,-aligned,-mixed}.json
  result_vllm_Qwen_Qwen3.5-9B_meetings_p3_n50_rot{0,1,2}_turncmp{,-aligned,-mixed}.json

Outputs:
  evaluation/figs/allprop_ask_stack.{png,pdf}
  (the paper copy lives at paper/<overleaf>/latex/images/turn_position_acceptance.pdf)

Run from the repository root:  python3 evaluation/turn_position_analysis.py
Requires: matplotlib (host python is fine; no GPU/backend needed).
"""
import argparse
import json
import math
import re
from collections import defaultdict

ALIGNS = ["aligned", "mixed", "conflicting"]
SUFFIX = {"aligned": "-aligned", "mixed": "-mixed", "conflicting": ""}
ASK_RE = re.compile(r"^Ask: (\S+)", re.M)
Z95 = 1.959964


def norm(name):
    return name.replace("_", " ").strip()


def outcomes_of(res):
    """Accepted/rejected sequence parsed from System events (the `accepted`
    flag in proposals_history is unreliable)."""
    out = []
    for e in res["conversation_history"]:
        if e["name"] == "System":
            if "Proposal Accepted" in e["content"]:
                out.append(True)
            elif "Proposal Rejected" in e["content"]:
                out.append(False)
    return out


def iter_proposals(scen_m, res_m):
    """Yield (seat, accepted, asked_before, prop_index, own_index, any_prior_accept)
    for every proposal, by walking the conversation (proposals appear as
    [Route Proposal] blocks in discussion-phase turns, in proposals_history order)."""
    seats = [p["name"] for p in scen_m["participants"]]
    res = res_m["results"]
    outc = outcomes_of(res)
    asked_so_far = defaultdict(set)
    own_count = defaultdict(int)
    in_vote = False
    k = 0
    any_acc = False
    for e in res["conversation_history"]:
        c = e["content"]
        if e["name"] == "System":
            if "Proposal Voting" in c:
                in_vote = True
            elif "Proposal Accepted" in c or "Proposal Rejected" in c:
                in_vote = False
            continue
        nm = norm(e["name"])
        if nm not in seats:
            continue
        pidx = c.find("[Route Proposal]")
        if pidx >= 0 and not in_vote and k < len(outc):
            pre = {norm(t) for t in ASK_RE.findall(c[:pidx])}
            asked = len((asked_so_far[nm] | pre) - {nm}) > 0
            own_count[nm] += 1
            yield (seats.index(nm), outc[k], asked, k, own_count[nm], any_acc)
            if outc[k]:
                any_acc = True
            k += 1
        for t in ASK_RE.findall(c):
            asked_so_far[nm].add(norm(t))


def wilson(k, n):
    p = k / n
    den = 1 + Z95 * Z95 / n
    ctr = (p + Z95 * Z95 / (2 * n)) / den
    half = Z95 * math.sqrt(p * (1 - p) / n + Z95 * Z95 / (4 * n * n)) / den
    return ctr - half, ctr + half


def mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else float("nan")


def load_all(data_dir):
    per = {}
    for a in ALIGNS:
        pairs = []
        for rot in range(3):
            scen = json.load(open(f"{data_dir}/meetings_p3_n50_rot{rot}_turncmp{SUFFIX[a]}.json"))["meetings"]
            resd = json.load(open(f"{data_dir}/result_vllm_Qwen_Qwen3.5-9B_meetings_p3_n50_rot{rot}_turncmp{SUFFIX[a]}.json"))["meetings"]
            for s, r in zip(scen, resd):
                assert s["title"] == r["title"]
                pairs.append((s, r))
        per[a] = pairs
    return per


def analyze(pairs):
    """All acceptance statistics for one alignment condition."""
    st = {
        "att": defaultdict(lambda: [0, 0]),        # seat -> [acc, n]
        "ask_split": defaultdict(lambda: [0, 0, 0, 0]),  # seat -> [n, acc_asked, acc_noask, n_asked]
        "first": defaultdict(lambda: [0, 0]),      # per-participant first proposal
        "first_ask": defaultdict(lambda: [0, 0, 0, 0]),
        "excl_open": defaultdict(lambda: [0, 0]),
        "by_k": defaultdict(lambda: [0, 0]),       # (seat, min(own_k,3))
        "by_phase": defaultdict(lambda: [0, 0]),   # (seat, pre/post)
        "made": defaultdict(list), "accepted": defaultdict(list),
        "per_meet": defaultdict(list),
    }
    for scen_m, res_m in pairs:
        m_cnt = defaultdict(lambda: [0, 0])
        for seat, acc, asked, k, own_k, prior_acc in iter_proposals(scen_m, res_m):
            st["att"][seat][0] += acc; st["att"][seat][1] += 1
            s4 = st["ask_split"][seat]
            s4[0] += 1; s4[3] += asked
            if acc and asked:
                s4[1] += 1
            elif acc:
                s4[2] += 1
            if own_k == 1:
                st["first"][seat][0] += acc; st["first"][seat][1] += 1
                f4 = st["first_ask"][seat]
                f4[0] += 1; f4[3] += asked
                if acc and asked:
                    f4[1] += 1
                elif acc:
                    f4[2] += 1
            if k > 0:
                st["excl_open"][seat][0] += acc; st["excl_open"][seat][1] += 1
            st["by_k"][(seat, min(own_k, 3))][0] += acc
            st["by_k"][(seat, min(own_k, 3))][1] += 1
            ph = "post" if prior_acc else "pre"
            st["by_phase"][(seat, ph)][0] += acc; st["by_phase"][(seat, ph)][1] += 1
            m_cnt[seat][0] += acc; m_cnt[seat][1] += 1
        for seat in range(3):
            st["made"][seat].append(m_cnt[seat][1])
            st["accepted"][seat].append(m_cnt[seat][0])
            if m_cnt[seat][1]:
                st["per_meet"][seat].append(m_cnt[seat][0] / m_cnt[seat][1])
    return st


def fmt(c):
    return f"{c[0]/c[1]:.2f}(n={c[1]})" if c[1] else "--"


def report(all_stats):
    for a in ALIGNS:
        st = all_stats[a]
        print(f"\n================ {a} ================")
        print("acceptance per attempt : " + " | ".join(f"p{s+1} {fmt(st['att'][s])}" for s in range(3)))
        for s in range(3):
            n, aa, an, na = st["ask_split"][s]
            print(f"  p{s+1}: acc(w/ ask) {aa/n:.2f} + acc(w/o ask) {an/n:.2f} = {(aa+an)/n:.2f}"
                  f" | asked-before rate {na/n:.2f}")
        print("first own proposal     : " + " | ".join(f"p{s+1} {fmt(st['first'][s])}" for s in range(3)))
        print("excl. opening proposal : " + " | ".join(f"p{s+1} {fmt(st['excl_open'][s])}" for s in range(3)))
        for kb, lbl in [(1, "1st own"), (2, "2nd own"), (3, "3rd+ own")]:
            print(f"  {lbl:8s}             : " + " | ".join(f"p{s+1} {fmt(st['by_k'][(s,kb)])}" for s in range(3)))
        for ph, lbl in [("pre", "before any accept"), ("post", "after >=1 accept")]:
            print(f"  {lbl:21s}: " + " | ".join(f"p{s+1} {fmt(st['by_phase'][(s,ph)])}" for s in range(3)))
        print("per-meeting equal weight mean: " + " | ".join(
            f"p{s+1} {mean(st['per_meet'][s]):.2f}" for s in range(3)))
        print("proposals made / accepted per meeting: " + " | ".join(
            f"p{s+1} {mean(st['made'][s]):.2f}/{mean(st['accepted'][s]):.2f}" for s in range(3)))


def draw_figure(all_stats, out_base):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import matplotlib.patches as mpatches
    from matplotlib.path import Path

    fig, ax = plt.subplots(figsize=(3.4, 2.4))
    W = 0.24
    col_ask, col_no = "#2e7d5b", "#b7d9c9"

    def rounded_top_path(x0, w, h, rx=0.045, ry=0.018):
        x1 = x0 + w
        v = [(x0, 0), (x0, h - ry), (x0, h), (x0 + rx, h),
             (x1 - rx, h), (x1, h), (x1, h - ry), (x1, 0), (x0, 0)]
        c = [Path.MOVETO, Path.LINETO, Path.CURVE3, Path.CURVE3,
             Path.LINETO, Path.CURVE3, Path.CURVE3, Path.LINETO, Path.CLOSEPOLY]
        return Path(v, c)

    for gi, a in enumerate(ALIGNS):
        for s in range(3):
            n, aa, an, na = all_stats[a]["ask_split"][s]
            r_ask, r_no = aa / n, an / n
            tot = r_ask + r_no
            x0 = gi + (s - 1) * (W + 0.03) - W / 2
            xc = x0 + W / 2
            clip = rounded_top_path(x0, W, tot)
            lower = mpatches.Rectangle((x0, 0), W, r_ask, facecolor=col_ask, linewidth=0)
            upper = mpatches.Rectangle((x0, r_ask), W, r_no, facecolor=col_no, linewidth=0)
            for p in (lower, upper):
                ax.add_patch(p)
                p.set_clip_path(clip, ax.transData)
            lo, hi = wilson(aa + an, n)
            ax.errorbar(xc, tot, yerr=[[tot - lo], [hi - tot]], fmt="none",
                        ecolor="#444444", elinewidth=0.7, capsize=1.6, capthick=0.7)
            ax.text(xc, hi + 0.014, f"{tot:.2f}", ha="center", fontsize=6)
            ax.text(xc, -0.052, f"p{s+1}", ha="center", fontsize=7)
    ax.set_xticks(range(3))
    ax.set_xticklabels(["\n" + a for a in ALIGNS], fontsize=8)
    ax.set_ylabel("proposal acceptance rate", fontsize=8)
    ax.tick_params(axis="y", labelsize=7)
    ax.tick_params(axis="x", length=0)
    ax.set_ylim(0, 0.9)
    ax.set_xlim(-0.55, 2.55)
    handles = [mpatches.Patch(facecolor=col_ask, label="w/ ask"),
               mpatches.Patch(facecolor=col_no, label="w/o ask")]
    ax.legend(handles=handles, loc="upper right", fontsize=7, framealpha=0.9,
              handlelength=1.2, handletextpad=0.5, borderpad=0.4, labelspacing=0.3)
    fig.tight_layout(pad=0.3)
    fig.savefig(out_base + ".png", dpi=200)
    fig.savefig(out_base + ".pdf")
    print(f"\nfigure saved: {out_base}.png / .pdf")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default="data")
    ap.add_argument("--out", default="evaluation/figs/allprop_ask_stack")
    ap.add_argument("--no-fig", action="store_true")
    args = ap.parse_args()

    per = load_all(args.data_dir)
    all_stats = {a: analyze(per[a]) for a in ALIGNS}
    report(all_stats)
    if not args.no_fig:
        draw_figure(all_stats, args.out)


if __name__ == "__main__":
    main()
