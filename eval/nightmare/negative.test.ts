/**
 * Negative controls for the nightmare answer checks: plausible wrong replies must fail and correct phrasings must
 * pass. Matchers come from checks.ts and the excuse regexes from the scenario modules (module constants only, no
 * manifest is read), so this runs without eval/.out. Decoys in a sentence that also states the answer are deliberately
 * forgiven (correct answers quote the decoy in context), so "30 minutes, not 47" or "41 committed, 46 remaining" are
 * known false-passes and have no row.
 */
import { describe, expect, test } from "bun:test";
import { N29_EXCUSE } from "./chaos-confluence.ts";
import { SUPERSEDED } from "./chaos-jira.ts";
import { OWNER_CONTRAST } from "./chaos-multi.ts";
import {
  dateMatcher,
  daysMatcher,
  eurMatcher,
  type Expectation,
  judge,
  minutesMatcher,
  nearMatcher,
  numberMatcher,
  pointsMatcher,
  roleDayMatcher,
  rx,
  sprintMatcher,
  statusCount,
  type Matcher,
} from "./checks.ts";
import { N11_EXCUSE } from "./scenarios.ts";

interface JudgeCase {
  id: string;
  expectations: Expectation[];
  excuse?: RegExp;
  wrong: string[];
  right: string[];
}

const MINUTES = "minutes?|mins?|perc";
const OPEN_LABEL = "open|blockers?|blocking|unresolved|remaining|outstanding|not done";

const JUDGE_CASES: JudgeCase[] = [
  {
    id: "n02 negated or hedged decoy",
    expectations: [{ label: "47", answer: numberMatcher("47"), decoys: [{ name: "30", match: numberMatcher("30", MINUTES) }] }],
    wrong: ["30 minutes. 47 appears elsewhere.", "The rollback window is 30 minutes. 47 appears elsewhere."],
    right: ["47 minutes", "47 minutes (not 30)", "The window is 47 minutes, not 30 minutes.", "47 minutes; the 30 minutes in comment 4 is the superseded estimate."],
  },
  {
    id: "n08 negated decoy",
    expectations: [{ label: "45 days", answer: numberMatcher("45"), decoys: [{ name: "150 days", match: numberMatcher("150", "days?|d|nap") }] }],
    wrong: ["150 days. 45 days was the early figure.", "The retention is 150 days."],
    right: ["45 days, not 150 days", "45 days rather than 150 days"],
  },
  {
    id: "n11 other-page excuse",
    expectations: [{ label: "1234", answer: numberMatcher("1234"), decoys: [{ name: "7731", match: numberMatcher("7731") }] }],
    excuse: N11_EXCUSE,
    wrong: ["Extension 7731. 1234 is also listed."],
    right: ["The Security page has 7731, the Engineering page has 1234.", "Extension 1234, updated from 7731.", "Extension 1234. Extension 7731, property is tier 1, owner `security`."],
  },
  {
    id: "n11 word tier",
    expectations: [{ label: "tier 3", answer: nearMatcher("tier", 3), decoys: [{ name: "tier 2", match: nearMatcher("tier", 2) }] }],
    wrong: ["The nm-owner tier is two."],
    right: ["The nm-owner tier is three.", "Tier 3"],
  },
  {
    id: "n16 answer sharing a sentence with a decoy",
    expectations: [{ label: "41 remaining", answer: pointsMatcher(41), decoys: [46, 44, 49].map((value) => ({ name: String(value), match: pointsMatcher(value) })) }],
    wrong: ["46 points remaining. 41 is the goal.", "The sprint has 46 points remaining."],
    right: ["41 remaining (46 committed earlier)", "41.0 points remaining", "41 remaining, not 46"],
  },
  {
    id: "n21 negated weekday",
    expectations: [{ label: "Corp: Thursday", answer: roleDayMatcher("corp", "engineering", "Thursday|csütörtök") }],
    wrong: ["Corp releases: Tuesday, not Thursday"],
    right: ["Corp releases need CAB on Thursdays", "Corp: Thursday"],
  },
  {
    id: "n26 negated person",
    expectations: [
      { label: "Réka Tóth", answer: rx(/Réka\s+Tóth/i), decoys: [{ name: "Gábor Szabó", match: rx(/Gábor\s+Szabó/i) }] },
    ],
    wrong: ["Gábor Szabó was assigned. Réka Tóth is listed."],
    right: ["Réka Tóth (not Gábor Szabó)"],
  },
  {
    id: "n26 minutes are exact",
    expectations: [{ label: "25 minutes", answer: minutesMatcher(25), decoys: [{ name: "15 minutes", match: minutesMatcher(15) }] }],
    wrong: ["26 minutes", "15 minutes. 25 is listed."],
    right: ["25 minutes"],
  },
  {
    id: "n27 negated command",
    expectations: [
      { label: "cachectl drain", answer: rx(/cachectl\s+drain/i), decoys: [{ name: "cachectl purge", match: rx(/cachectl\s+purge/i) }] },
    ],
    wrong: ["Step 3 runs cachectl purge. cachectl drain is on the page too."],
    right: ["Step 3 runs cachectl drain, not cachectl purge"],
  },
  {
    id: "n28 negated bridge",
    expectations: [{ label: "bridge 0142", answer: rx(/555\s0142/), decoys: [{ name: "bridge 0188", match: rx(/555\s0188/) }] }],
    wrong: ["bridge +36 1 555 0188. 555 0142 is also on the page."],
    right: ["bridge +36 1 555 0142 (not +36 1 555 0188)"],
  },
  {
    id: "n29 hand-written count in the answer sentence",
    expectations: [
      {
        label: "6 open",
        answer: rx(/(?<![\d.-])6(?!\d)/),
        decoys: [{ name: "9 (hand-written count)", match: nearMatcher(OPEN_LABEL, 9) }],
      },
    ],
    excuse: N29_EXCUSE,
    wrong: ["9 blockers. 6 open elsewhere."],
    right: ["6 open, not 9 blockers", "6 open; the page says 9 blockers."],
  },
  {
    id: "n31 runner-up owner",
    expectations: [
      {
        label: "owner Dóra Lengyel",
        answer: rx(/Lengyel/i),
        decoys: [{ name: "Péter Vass with the most", match: (text) => /Vass/i.test(text) && /\b(?:most|highest|largest|biggest|top|winner|responsible|owns)\b/i.test(text) }],
      },
    ],
    excuse: OWNER_CONTRAST,
    wrong: ["Péter Vass owns the most issues. Dóra Lengyel is listed."],
    right: ["Dóra Lengyel owns the most; Péter Vass has fewer.", "Dóra Lengyel owns 4. Péter Vass's team has the most open issues of any single team, but Dóra's two together have more."],
  },
  {
    id: "n25 date before the edit",
    expectations: [
      { label: "go-live 2026-12-18", answer: dateMatcher("2026-12-18"), decoys: [{ name: "2026-12-15", match: dateMatcher("2026-12-15") }] },
    ],
    excuse: SUPERSEDED,
    wrong: ["Go-live is 2026-12-18. Go-live is 2026-12-15."],
    right: ["Go-live is 2026-12-18. So the date was probably 2026-12-15 before the edit."],
  },
];

for (const scenario of JUDGE_CASES) {
  describe(scenario.id, () => {
    test("rejects wrong replies", () => {
      for (const text of scenario.wrong) {
        expect(judge(text, scenario.expectations, scenario.excuse).success, text).toBe(false);
      }
    });
    test("accepts correct replies", () => {
      for (const text of scenario.right) {
        expect(judge(text, scenario.expectations, scenario.excuse).success, text).toBe(true);
      }
    });
  });
}

interface MatcherCase {
  id: string;
  matcher: Matcher;
  yes: string[];
  no: string[];
}

const MATCHER_CASES: MatcherCase[] = [
  { id: "n04 unit is required when given", matcher: numberMatcher("19.35", "bps|basis points"), yes: ["19.35 bps", "19.35 basis points"], no: ["19.35%", "MERCH-0731 is 19.35"] },
  { id: "n05 minutes are exact", matcher: minutesMatcher(1655), yes: ["27h35m", "27h 35m", "27 hours 35 minutes", "1655 min", "27.58 hours"], no: ["1656 minutes", "1654 min", "27.5 hours"] },
  { id: "n06 hyphen guard", matcher: numberMatcher("16"), yes: ["16 open", "total 16"], no: ["2026-10-16", "NMS-16"] },
  { id: "n16 decimal points", matcher: pointsMatcher(41), yes: ["41 points", "41.0 points", "41.00"], no: ["NMS-41", "41.5 points", "141 points", "2026-10-41"] },
  { id: "n18 sprint names", matcher: sprintMatcher("1", 13), yes: ["Sprint 1: 13", "Sprint One completed 13 points", "13 points in the first sprint", "Sprint 1 ... 13.0"], no: ["Sprint 2: 13", "Sprint 1: 31", "Sprint 10: 13"] },
  { id: "n20 EUR forms", matcher: eurMatcher(25), yes: ["25 EUR", "EUR 25", "25.00 EUR", "€25", "25 euros", "€ 25.00"], no: ["EUR 250", "25.50 EUR", "125 EUR", "€25.5"] },
  { id: "n20 day forms", matcher: daysMatcher(30), yes: ["30 days", "30.0 days", "thirty days", "thirty-day", "30 calendar days", "30 nap"], no: ["300 days", "30 weeks", "130 days", "thirty-five days"] },
  { id: "n11 near words", matcher: nearMatcher("tier", 3), yes: ["tier three", "Tier 3", "3 is the tier"], no: ["tier 30", "tier 2", "tier-3x4"] },
  { id: "n14 word counts", matcher: nearMatcher("direct|child|children", 40), yes: ["forty direct children", "40 direct children", "direct children: 40"], no: ["forty-two direct children", "NMS-40 child", "400 direct children"] },
  { id: "n22 durations", matcher: minutesMatcher(210), yes: ["3h 30m", "3.5 hours", "210 minutes", "12600 seconds"], no: ["209 minutes", "211 min", "12540 seconds"] },
  { id: "n06 unaccented statuses", matcher: statusCount("Teendő", 3), yes: ["Teendő: 3", "Teendo: 3", "To Do 3"], no: ["Teendo: 4"] },
  { id: "n06 unaccented done", matcher: statusCount("Kész", 4), yes: ["Kész: 4", "Kesz: 4", "Done: 4"], no: ["Kesz: 5"] },
  { id: "n06 unaccented review", matcher: statusCount("Ellenőrzés alatt", 2), yes: ["Ellenorzes alatt: 2", "In Review 2"], no: ["Ellenorzes alatt: 3"] },
];

for (const scenario of MATCHER_CASES) {
  describe(`matcher: ${scenario.id}`, () => {
    test("matches the right forms", () => {
      for (const text of scenario.yes) {
        expect(scenario.matcher(text), text).toBe(true);
      }
    });
    test("rejects the wrong ones", () => {
      for (const text of scenario.no) {
        expect(scenario.matcher(text), text).toBe(false);
      }
    });
  });
}
