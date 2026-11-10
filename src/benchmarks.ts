// What "normal" looks like in the job market, from published data. The strategist is
// judged against these, so a quiet month reads as a quiet month and not as failure.
// Every figure is vendor or survey data, not peer-reviewed research, so the statistics
// built on them are deliberately conservative.

export interface Source {
  name: string;
  url: string;
  note: string;
}

export const SOURCES: Source[] = [
  {
    name: "CareerPlug 2025 Recruiting Metrics Report",
    url: "https://www.careerplug.com/recruiting-metrics-and-kpis/",
    note: "2024 hiring data from 60,000+ small businesses and 10M+ applications: 3% of applicants were invited to interview; 27% of interviews led to a hire; 180 applicants per hire.",
  },
  {
    name: "Huntr 2025 Annual Job Search Trends Report",
    url: "https://huntr.co/research/2025-annual-job-search-trends-report",
    note: "1.7M tracked applications: tailored resumes converted to interviews or offers at ~5.8% vs ~3.7% untailored; channel response rates from 2.8% (ZipRecruiter) and 3.1% (LinkedIn) to 8.7% (GovernmentJobs) and 11.3% (Google Jobs); median 23 days to first interview, 75th percentile over two months, 90th over four; nearly 1 in 5 job seekers sent over 100 applications before an offer.",
  },
];

/** Interview rate per application to expect, by how applications are prepared. */
export const BASELINE = {
  tailored: 0.05, // Huntr: ~5.8% tailored, shaded down for self-reporting optimism
  efficiency: 0.03, // CareerPlug 3%; Huntr ~3.7% untailored
};

/**
 * A track is only judged to be failing when it is very likely below this rate:
 * worse than every benchmark above, including crowded entry-level markets.
 */
export const FLOOR = 0.01;

/** Of employers who will respond with an interview, the share who have done so by `days` after applying. */
const RESPONSE_CURVE: [number, number][] = [
  [0, 0],
  [7, 0.2],
  [23, 0.5], // Huntr median to first interview
  [60, 0.75], // Huntr 75th percentile: over two months
  [120, 0.9], // Huntr 90th percentile: past four months
  [180, 1],
];

/**
 * How much an application with no reply yet counts as a "no": a week-old application
 * has barely had a chance; a four-month-old one almost certainly would have heard by now.
 */
export function exposure(days: number): number {
  if (days <= 0) return 0;
  for (let i = 1; i < RESPONSE_CURVE.length; i++) {
    const [d1, p1] = RESPONSE_CURVE[i];
    if (days <= d1) {
      const [d0, p0] = RESPONSE_CURVE[i - 1];
      return p0 + ((p1 - p0) * (days - d0)) / (d1 - d0);
    }
  }
  return 1;
}

/** Plain-language context for the strategist, so it calibrates its reading of the numbers. */
export function benchmarkBrief(mode: "tailored" | "efficiency"): string {
  const p = BASELINE[mode];
  const zero = (n: number) => Math.round((1 - p) ** n * 100);
  return [
    `Expect roughly ${Math.round(p * 1000) / 10}% of applications to become interviews in ${mode} mode; about 1 in ${Math.round(1 / p)}.`,
    `With that rate, zero interviews is common for a long time: ${zero(20)}% likely after 20 applications, ${zero(40)}% after 40, ${zero(80)}% after 80.`,
    "Replies are slow: half of eventual interviews arrive within ~23 days, a quarter take over two months. Unanswered recent applications are not failures yet.",
    `How the verdicts work: a track stays "too early" until about 30 applications have had time to be answered. It is judged "underperforming" only when it is very likely converting below ${FLOOR * 100}% (typically 200+ answered-or-aged applications with no interviews), and "outperforming" when it is very likely beating the benchmark with at least two interviews.`,
    "Employers average about 180 applicants per hire, and nearly 1 in 5 job seekers sent over 100 applications before an offer.",
    `Sources: ${SOURCES.map((s) => s.name).join("; ")}.`,
  ].join("\n");
}
