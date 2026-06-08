/**
 * Duplicate Detection
 * -------------------
 * Finds likely-duplicate leads using weighted signal matching. Exact matches on
 * email or normalised phone are strong; company-name + city similarity is
 * supporting. Produces a 0..1 score and the list of reasons for the reviewer.
 *
 * For large datasets, blocking keys (email domain, phone last-7, company prefix)
 * keep comparisons near-linear instead of O(n^2) — see candidatePairs().
 */

function normEmail(e) {
  return (e || "").trim().toLowerCase();
}
function normPhone(p) {
  return (p || "").replace(/\D/g, "").slice(-10); // last 10 digits
}
function normCompany(c) {
  return (c || "")
    .toLowerCase()
    .replace(/\b(pvt|private|ltd|limited|llp|llc|inc|corp|co|company)\b\.?/g, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

// Normalised Levenshtein similarity (0..1).
function similarity(a, b) {
  a = a || ""; b = b || "";
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
  return 1 - dp[m][n] / Math.max(m, n);
}

function scorePair(a, b) {
  const reasons = [];
  let score = 0;

  if (a.email && normEmail(a.email) === normEmail(b.email)) {
    score = Math.max(score, 0.95);
    reasons.push("Identical email");
  }
  const pa = normPhone(a.phonePrimary), pb = normPhone(b.phonePrimary);
  if (pa && pa === pb) {
    score = Math.max(score, 0.9);
    reasons.push("Identical phone");
  }
  const compSim = similarity(normCompany(a.companyName), normCompany(b.companyName));
  if (compSim > 0.85) {
    const citySim = a.city && b.city ? similarity(a.city.toLowerCase(), b.city.toLowerCase()) : 0;
    const combined = 0.6 * compSim + 0.4 * citySim;
    if (combined > 0.7) {
      score = Math.max(score, combined);
      reasons.push(`Company match (${(compSim * 100) | 0}%)`);
      if (citySim > 0.8) reasons.push("Same city");
    }
  }
  return { score: Number(score.toFixed(3)), reasons };
}

/** Blocking: only compare leads that share a cheap key. */
function candidatePairs(leads) {
  const buckets = new Map();
  const addTo = (key, lead) => {
    if (!key) return;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(lead);
  };
  for (const l of leads) {
    addTo("e:" + normEmail(l.email), l);
    addTo("p:" + normPhone(l.phonePrimary), l);
    addTo("c:" + normCompany(l.companyName).slice(0, 6), l);
  }
  const seen = new Set();
  const pairs = [];
  for (const group of buckets.values()) {
    for (let i = 0; i < group.length; i++)
      for (let j = i + 1; j < group.length; j++) {
        const [a, b] = group[i].id < group[j].id ? [group[i], group[j]] : [group[j], group[i]];
        const key = a.id + "|" + b.id;
        if (a.id === b.id || seen.has(key)) continue;
        seen.add(key);
        pairs.push([a, b]);
      }
  }
  return pairs;
}

/** Returns duplicate records ready to upsert: {leadAId, leadBId, score, reasons}. */
function findDuplicates(leads, threshold = 0.7) {
  const out = [];
  for (const [a, b] of candidatePairs(leads)) {
    const { score, reasons } = scorePair(a, b);
    if (score >= threshold) {
      out.push({ leadAId: a.id, leadBId: b.id, score, reasons });
    }
  }
  return out;
}

module.exports = { findDuplicates, scorePair, similarity };
