/**
 * Analytics Engine
 * ----------------
 * Every metric is computed live from the database — no hardcoded or sample
 * values. Uses Prisma aggregations / groupBy so it scales.
 *
 * Exposes the dashboard KPIs and the report set (industry/state/city
 * distributions, duplicate analysis, CRM readiness, data quality, export &
 * processing stats).
 */

function topN(grouped, key, n = 5) {
  return grouped
    .filter((g) => g[key])
    .map((g) => ({ label: g[key], count: g._count?._all ?? g._count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
}

async function dashboard(prisma) {
  const [
    totalFiles,
    cardsDetected,
    cardsProcessed,
    leadsCreated,
    duplicatesFound,
    exportCount,
    approved,
    topIndustriesRaw,
    topCitiesRaw,
    topStatesRaw,
    recentImports,
    recentExports,
    recentActivity,
  ] = await Promise.all([
    prisma.upload.count(),
    prisma.card.count(),
    prisma.ocrResult.count(),
    prisma.lead.count({ where: { deletedAt: null } }),
    prisma.duplicate.count({ where: { status: "OPEN" } }),
    prisma.export.count(),
    prisma.lead.count({ where: { status: "APPROVED", deletedAt: null } }),
    prisma.company.groupBy({ by: ["industry"], _count: { _all: true } }),
    prisma.lead.groupBy({ by: ["city"], _count: { _all: true }, where: { deletedAt: null } }),
    prisma.lead.groupBy({ by: ["state"], _count: { _all: true }, where: { deletedAt: null } }),
    prisma.upload.findMany({ orderBy: { createdAt: "desc" }, take: 5 }),
    prisma.export.findMany({ orderBy: { createdAt: "desc" }, take: 5 }),
    prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 10 }),
  ]);

  const successRate = cardsDetected
    ? Number(((cardsProcessed / cardsDetected) * 100).toFixed(1))
    : 0;

  return {
    kpis: {
      totalFiles,
      cardsDetected,
      cardsProcessed,
      leadsCreated,
      duplicatesFound,
      successRate,
      exportCount,
      approved,
    },
    topIndustries: topN(topIndustriesRaw, "industry"),
    topCities: topN(topCitiesRaw, "city"),
    topStates: topN(topStatesRaw, "state"),
    recentImports,
    recentExports,
    recentActivity,
  };
}

async function reports(prisma) {
  const [
    byIndustry,
    byState,
    byCity,
    total,
    approved,
    withEmail,
    withPhone,
    withGstin,
    dupes,
    exportsByFormat,
    acquisition,
  ] = await Promise.all([
    prisma.company.groupBy({
      by: ["industry"],
      _count: { _all: true },
      orderBy: { _count: { industry: "desc" } },
      take: 20,
    }),
    prisma.lead.groupBy({
      by: ["state"],
      _count: { _all: true },
      orderBy: { _count: { state: "desc" } },
      take: 20,
    }),
    prisma.lead.groupBy({
      by: ["city"],
      _count: { _all: true },
      orderBy: { _count: { city: "desc" } },
      take: 20,
    }),
    prisma.lead.count(),
    prisma.lead.count({ where: { status: "APPROVED" } }),
    prisma.lead.count({ where: { email: { not: null } } }),
    prisma.lead.count({ where: { phonePrimary: { not: null } } }),
    prisma.lead.count({ where: { gstin: { not: null } } }),
    prisma.duplicate.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.export.groupBy({ by: ["format"], _count: { _all: true } }),
    // Safe tagged-template raw query — no user input is interpolated
    prisma.$queryRaw`
      SELECT date_trunc('day', "scannedAt") AS day, count(*)::int AS count
      FROM leads GROUP BY 1 ORDER BY 1 DESC LIMIT 30
    `,
  ]);

  const pct = (x) => (total ? Number(((x / total) * 100).toFixed(1)) : 0);

  return {
    leadAcquisition: acquisition,
    industryDistribution: topN(byIndustry, "industry", 20),
    stateDistribution: topN(byState, "state", 20),
    cityDistribution: topN(byCity, "city", 20),
    duplicateAnalysis: dupes.map((d) => ({
      status: d.status,
      count: d._count._all,
    })),
    crmReadiness: {
      total,
      approved,
      approvedPct: pct(approved),
    },
    dataQuality: {
      withEmailPct: pct(withEmail),
      withPhonePct: pct(withPhone),
      withGstinPct: pct(withGstin),
    },
    exportStatistics: exportsByFormat.map((e) => ({
      format: e.format,
      count: e._count._all,
    })),
    processingStatistics: {
      uploads: await prisma.upload.groupBy({
        by: ["status"],
        _count: { _all: true },
      }),
    },
  };
}

/**
 * Per-employee lead generation, grouped by employee and date.
 * The owner of a lead is whoever uploaded its source card. Prisma groupBy can't
 * traverse relations, so this uses a parameter-free raw query (no user input
 * interpolated — safe).
 * Returns rows: { userId, name, email, date (YYYY-MM-DD), count }.
 */
async function employeeReport(prisma) {
  const rows = await prisma.$queryRaw`
    SELECT u.id   AS "userId",
           u.name AS "name",
           u.email AS "email",
           to_char(l."createdAt", 'YYYY-MM-DD') AS "date",
           COUNT(*)::int AS "count"
    FROM leads l
    JOIN cards   c  ON c.id  = l."cardId"
    JOIN uploads up ON up.id = c."uploadId"
    JOIN users   u  ON u.id  = up."uploadedById"
    WHERE l."deletedAt" IS NULL
    GROUP BY u.id, u.name, u.email, to_char(l."createdAt", 'YYYY-MM-DD')
    ORDER BY "date" DESC, "count" DESC
  `;
  return rows;
}

module.exports = { dashboard, reports, employeeReport };
