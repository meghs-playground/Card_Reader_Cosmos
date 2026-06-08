const prisma = require("../config/db");
const analytics = require("../services/analyticsService");

async function getDashboard(req, res, next) {
  try { res.json(await analytics.dashboard(prisma)); } catch (e) { next(e); }
}
async function getReports(req, res, next) {
  try { res.json(await analytics.reports(prisma)); } catch (e) { next(e); }
}

module.exports = { getDashboard, getReports };
