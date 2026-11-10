// Small, dependency-free Bayesian helpers. Interview rates are modeled as Beta
// distributions and compared by sampling, which is plenty precise for weekly decisions.

/** Deterministic PRNG so the same data always yields the same verdict. */
export function rng(seed = 0x9e3779b9): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(r: () => number): number {
  const u = 1 - r();
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Marsaglia-Tsang gamma sampler. */
function gamma(shape: number, r: () => number): number {
  if (shape < 1) return gamma(shape + 1, r) * r() ** (1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(r);
      v = 1 + c * x;
    } while (v <= 0);
    v = v ** 3;
    const u = r();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function betaSample(a: number, b: number, r: () => number): number {
  const x = gamma(a, r);
  const y = gamma(b, r);
  return x / (x + y);
}

export interface Posterior {
  a: number;
  b: number;
}

/** P(rate < x) under Beta(a, b), estimated by sampling. */
export function probBelow(p: Posterior, x: number, n = 6000, seed?: number): number {
  const r = rng(seed);
  let below = 0;
  for (let i = 0; i < n; i++) if (betaSample(p.a, p.b, r) < x) below++;
  return below / n;
}

/**
 * Thompson allocation: the share of draws in which each option has the highest sampled
 * rate. It favors what's working while every option keeps some chance of being tried.
 */
export function thompsonShares(ps: Posterior[], n = 4000, seed?: number): number[] {
  const r = rng(seed);
  const wins = ps.map(() => 0);
  for (let i = 0; i < n; i++) {
    let best = 0;
    let bestV = -1;
    ps.forEach((p, j) => {
      const v = betaSample(p.a, p.b, r);
      if (v > bestV) {
        bestV = v;
        best = j;
      }
    });
    wins[best]++;
  }
  return wins.map((w) => w / n);
}
