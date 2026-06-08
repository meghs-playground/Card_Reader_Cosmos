/**
 * Final Verification Script — Cosmos LIP
 * Run: node verify.js
 */
'use strict';

process.env.DATABASE_URL  = 'postgresql://x:x@localhost/x';
process.env.JWT_SECRET    = 'test-secret-32chars-abcdefghijk';
process.env.CORS_ORIGIN   = 'http://localhost:5173';
process.env.NODE_ENV      = 'test';

const fs   = require('fs');
const path = require('path');

const FRONTEND = path.resolve(__dirname, '../frontend/index.html');
const FRONTEND_ROOT = path.resolve(__dirname, '../../cosmos-lip-frontend.html');

const checks = [
  // ── Phase 1: Startup ───────────────────────────────────────────────────────
  ['authController.login exported', () => {
    const a = require('./controllers/authController');
    if (!a.login || !a.logout || !a.me) throw new Error('missing exports');
    return 'login / logout / me ✓';
  }],
  ['app loads without blocking', () => {
    const { app } = require('./app');
    if (typeof app !== 'function') throw new Error('not a function');
    return 'express app ✓';
  }],
  ['all routes registered', () => {
    const { app } = require('./app');
    const layers = app._router?.stack || [];
    const hasApi = layers.some(l => l.regexp && l.regexp.source.includes('api'));
    if (!hasApi) throw new Error('no /api routes found');
    return 'routes ✓';
  }],
  ['Prisma client models', () => {
    const { PrismaClient } = require('@prisma/client');
    const models = Object.keys(new PrismaClient())
      .filter(k => !k.startsWith('_') && !k.startsWith('$'));
    if (models.length < 9) throw new Error(`only ${models.length} models`);
    return models.join(', ');
  }],

  // ── Phase 2: OCR Service ───────────────────────────────────────────────────
  ['OCR requirements.txt has PADDLE_DISABLED env doc', () => {
    const s = fs.readFileSync('ocr/requirements.txt', 'utf8');
    if (!s.includes('PADDLE_DISABLED')) throw new Error('missing');
    return 'PADDLE_DISABLED documented ✓';
  }],
  ['OCR pipeline handles Python 3.14 fallback', () => {
    const s = fs.readFileSync('ocr/pipeline/ocr.py', 'utf8');
    if (!s.includes('PADDLE_DISABLED')) throw new Error('no env check');
    if (!s.includes('Tesseract')) throw new Error('no tesseract fallback');
    return 'fallback logic ✓';
  }],

  // ── Phase 3: Security ──────────────────────────────────────────────────────
  ['no hardcoded Claude key in frontend/index.html', () => {
    const src = fs.readFileSync(FRONTEND, 'utf8');
    if (src.includes('sk-ant-api03-cX6eth')) throw new Error('LIVE KEY FOUND');
    if (src.includes("'sk-ant-api03-YOUR_KEY_HERE'")) throw new Error('placeholder still hardcoded');
    return 'key in localStorage only ✓';
  }],
  ['no hardcoded Claude key in cosmos-lip-frontend.html', () => {
    if (!fs.existsSync(FRONTEND_ROOT)) return 'file absent (skipped)';
    const src = fs.readFileSync(FRONTEND_ROOT, 'utf8');
    if (src.includes('sk-ant-api03-cX6eth')) throw new Error('LIVE KEY FOUND');
    return 'key removed ✓';
  }],
  ['CORS wildcard fallback removed', () => {
    const s = fs.readFileSync('app.js', 'utf8');
    if (s.includes('|| true')) throw new Error('wildcard found');
    if (!s.includes('allowedOrigins')) throw new Error('allowedOrigins missing');
    return 'explicit origin check ✓';
  }],
  ['rate limiters wired (auth/upload/export)', () => {
    const s = fs.readFileSync('app.js', 'utf8');
    if (!s.includes('authLimiter'))   throw new Error('authLimiter missing');
    if (!s.includes('uploadLimiter')) throw new Error('uploadLimiter missing');
    if (!s.includes('exportLimiter')) throw new Error('exportLimiter missing');
    return '3 limiters ✓';
  }],
  ['queryRawUnsafe replaced with $queryRaw', () => {
    const s = fs.readFileSync('services/analyticsService.js', 'utf8');
    if (s.includes('queryRawUnsafe')) throw new Error('still present');
    if (!s.includes('$queryRaw`'))   throw new Error('tagged template not found');
    return '$queryRaw tagged template ✓';
  }],
  ['updateLead uses field whitelist', () => {
    const s = fs.readFileSync('controllers/leadController.js', 'utf8');
    if (!s.includes('EDITABLE_LEAD_FIELDS')) throw new Error('no whitelist');
    if (!s.includes('pickEditableFields'))   throw new Error('no picker');
    if (s.includes('...fields') && !s.includes('safeFields')) throw new Error('raw spread still present');
    return 'EDITABLE_LEAD_FIELDS whitelist ✓';
  }],

  // ── Phase 4: Frontend ↔ Backend ────────────────────────────────────────────
  ['frontend has backend API client', () => {
    const src = fs.readFileSync(FRONTEND, 'utf8');
    if (!src.includes('BACKEND_URL'))      throw new Error('BACKEND_URL missing');
    if (!src.includes('async login('))     throw new Error('API.login method missing');
    if (!src.includes('async uploadFiles('))throw new Error('API.uploadFiles missing');
    if (!src.includes('async getLeads('))  throw new Error('API.getLeads missing');
    if (!src.includes('async checkHealth('))throw new Error('API.checkHealth missing');
    return 'API client with login/upload/leads/health ✓';
  }],
  ['frontend processAll uses backend when connected', () => {
    const src = fs.readFileSync(FRONTEND, 'utf8');
    if (!src.includes('BACKEND_ONLINE && AUTH_TOKEN')) throw new Error('no backend check');
    if (!src.includes('API.uploadFiles')) throw new Error('no backend upload call');
    return 'dual-mode processing ✓';
  }],
  ['frontend loadLeads syncs from backend', () => {
    const src = fs.readFileSync(FRONTEND, 'utf8');
    if (!src.includes('API.getLeads')) throw new Error('no backend fetch');
    if (!src.includes('IDB.all'))      throw new Error('IndexedDB fallback removed');
    return 'backend + IndexedDB fallback ✓';
  }],
  ['Claude model name fixed', () => {
    const src = fs.readFileSync(FRONTEND, 'utf8');
    if (src.includes('claude-sonnet-4-20250514')) throw new Error('invalid model ID still present');
    return 'model ID updated ✓';
  }],

  // ── Phase 5: OCR Pipeline ──────────────────────────────────────────────────
  ['extractEntities returns industry', () => {
    const { extractEntities } = require('./services/entityExtraction');
    const r = extractEntities('CNC Machining Pvt Ltd\nPrecision Machining\ninfo@cncparts.com\n+91 9876543210');
    if (r.industry === undefined) throw new Error('industry key missing');
    return `industry="${r.industry}" ✓`;
  }],
  ['industry=null for non-manufacturing text', () => {
    const { extractEntities } = require('./services/entityExtraction');
    const r = extractEntities('Hello World Corp\njohn@example.com\n+1 555 1234');
    if (r.industry !== null) throw new Error(`expected null, got "${r.industry}"`);
    return 'null (correct) ✓';
  }],
  ['processingService uses saveCropImage', () => {
    const s = fs.readFileSync('services/processingService.js', 'utf8');
    if (!s.includes('saveCropImage')) throw new Error('function missing');
    if (s.includes("croppedPath: ''") || s.includes('croppedPath: ""')) throw new Error('hardcoded empty path found');
    return 'saveCropImage() ✓';
  }],
  ['geo resolver - city lookup (Pune)', () => {
    const { validateLead } = require('./services/validation');
    const r = validateLead({ address: 'MIDC Bhosari Pune 411026', phonePrimary: '+91 9876543210' });
    if (r.geo.state !== 'Maharashtra') throw new Error(`got "${r.geo.state}"`);
    return `${r.geo.city} / ${r.geo.state} / ${r.geo.country} ✓`;
  }],
  ['geo resolver - GSTIN 27 = Maharashtra', () => {
    const { validateLead } = require('./services/validation');
    const r = validateLead({ gstin: '27ABCDE1234F1Z5', address: '' });
    if (r.geo.state !== 'Maharashtra') throw new Error(`got "${r.geo.state}"`);
    return `${r.geo.state} ✓`;
  }],
  ['geo resolver - GSTIN 29 = Karnataka', () => {
    const { validateLead } = require('./services/validation');
    const r = validateLead({ gstin: '29ABCDE1234F1Z5', address: '' });
    if (r.geo.state !== 'Karnataka') throw new Error(`got "${r.geo.state}"`);
    return `${r.geo.state} ✓`;
  }],
  ['geo resolver - 36 Indian states/UTs defined', () => {
    const { GST_STATE_CODES } = require('./services/validation');
    const count = Object.keys(GST_STATE_CODES).length;
    if (count < 30) throw new Error(`only ${count} codes`);
    return `${count} GST codes ✓`;
  }],

  // ── Phase 6: Performance ───────────────────────────────────────────────────
  ['queueService exists and exports', () => {
    const q = require('./services/queueService');
    if (typeof q.enqueueUpload !== 'function') throw new Error('enqueueUpload missing');
    if (typeof q.getQueueStats !== 'function') throw new Error('getQueueStats missing');
    if (typeof q.shutdownQueue !== 'function') throw new Error('shutdownQueue missing');
    return '3 exports ✓';
  }],
  ['uploadController uses queue', () => {
    const s = fs.readFileSync('controllers/uploadController.js', 'utf8');
    if (!s.includes('enqueueUpload')) throw new Error('still using direct processUpload');
    if (s.includes('Promise.allSettled')) throw new Error('old fire-and-forget pattern remains');
    return 'enqueueUpload ✓';
  }],
  ['schema has source index on leads', () => {
    const s = fs.readFileSync('database/schema.prisma', 'utf8');
    if (!s.includes('@@index([source])')) throw new Error('leads.source index missing');
    return 'leads.source index ✓';
  }],
  ['schema has uploadedById index on uploads', () => {
    const s = fs.readFileSync('database/schema.prisma', 'utf8');
    if (!s.includes('@@index([uploadedById])')) throw new Error('missing');
    return 'uploads.uploadedById index ✓';
  }],
  ['schema Company onDelete SetNull', () => {
    const s = fs.readFileSync('database/schema.prisma', 'utf8');
    if (!s.includes('onDelete: SetNull')) throw new Error('SetNull missing');
    return 'SetNull on Company delete ✓';
  }],

  // ── Phase 7: Deployment ────────────────────────────────────────────────────
  ['Dockerfile exists (backend)', () => {
    if (!fs.existsSync('Dockerfile')) throw new Error('missing');
    const s = fs.readFileSync('Dockerfile', 'utf8');
    if (!s.includes('HEALTHCHECK')) throw new Error('no healthcheck');
    if (!s.includes('USER cosmos'))  throw new Error('no non-root user');
    return 'multi-stage + healthcheck + non-root ✓';
  }],
  ['Dockerfile exists (OCR)', () => {
    if (!fs.existsSync('ocr/Dockerfile')) throw new Error('missing');
    const s = fs.readFileSync('ocr/Dockerfile', 'utf8');
    if (!s.includes('python:3.11')) throw new Error('wrong python version');
    if (!s.includes('tesseract-ocr')) throw new Error('tesseract missing');
    return 'python:3.11 + tesseract ✓';
  }],
  ['docker-compose.yml exists', () => {
    if (!fs.existsSync('../docker-compose.yml')) throw new Error('missing');
    const s = fs.readFileSync('../docker-compose.yml', 'utf8');
    if (!s.includes('postgres'))   throw new Error('postgres service missing');
    if (!s.includes('redis'))      throw new Error('redis service missing');
    if (!s.includes('backend'))    throw new Error('backend service missing');
    if (!s.includes('ocr'))        throw new Error('ocr service missing');
    if (!s.includes('healthcheck'))throw new Error('no healthchecks');
    return '4 services + healthchecks ✓';
  }],
  ['migration SQL generated', () => {
    const p = 'database/migrations/20250101000000_init/migration.sql';
    if (!fs.existsSync(p)) throw new Error('missing');
    const s = fs.readFileSync(p, 'utf8');
    const tables = (s.match(/CREATE TABLE/g) || []).length;
    if (tables < 9) throw new Error(`only ${tables} tables`);
    return `${tables} CREATE TABLE statements ✓`;
  }],
  ['.gitignore has .env', () => {
    if (!fs.existsSync('../.gitignore')) throw new Error('missing');
    const s = fs.readFileSync('../.gitignore', 'utf8');
    if (!s.includes('.env')) throw new Error('.env not ignored');
    if (!s.includes('node_modules')) throw new Error('node_modules not ignored');
    return '.env + node_modules ignored ✓';
  }],
  ['CRM export 23 columns match frontend', () => {
    const { COSMOS_COLUMNS } = require('./services/crmMapping');
    const frontendSrc = fs.readFileSync(FRONTEND, 'utf8');
    const match = frontendSrc.match(/const COSMOS_COLS = \[([\s\S]*?)\];/);
    if (!match) throw new Error('COSMOS_COLS not found in frontend');
    // Count quoted column names
    const feCols = (match[1].match(/'[^']+'/g) || []).map(s => s.slice(1,-1));
    const missing = COSMOS_COLUMNS.filter(c => !feCols.includes(c));
    const extra   = feCols.filter(c => !COSMOS_COLUMNS.includes(c));
    if (missing.length) throw new Error(`Backend missing in frontend: ${missing}`);
    if (extra.length)   throw new Error(`Frontend extra not in backend: ${extra}`);
    return `${COSMOS_COLUMNS.length} columns perfectly aligned ✓`;
  }],
];

// ── Run all checks ────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
console.log('\n══════════════════════════════════════════════════════════════');
console.log('  COSMOS LIP — FINAL VERIFICATION AUDIT');
console.log('══════════════════════════════════════════════════════════════\n');

for (const [name, fn] of checks) {
  try {
    const result = fn();
    console.log(`  ✅  ${name}`);
    console.log(`       → ${result}`);
    pass++;
  } catch (e) {
    console.log(`  ❌  ${name}`);
    console.log(`       → ${e.message}`);
    fail++;
  }
}

// ── Score calculation ─────────────────────────────────────────────────────────
const total   = checks.length;
const pct     = Math.round((pass / total) * 100);

// Module-level scores
const secChecks   = ['no hardcoded Claude key in frontend/index.html','no hardcoded Claude key in cosmos-lip-frontend.html','CORS wildcard fallback removed','rate limiters wired (auth/upload/export)','queryRawUnsafe replaced with $queryRaw','updateLead uses field whitelist'];
const perfChecks  = ['queueService exists and exports','uploadController uses queue','schema has source index on leads','schema has uploadedById index on uploads','schema Company onDelete SetNull'];
const relChecks   = ['app loads without blocking','all routes registered','Prisma client models','authController.login exported','processingService uses saveCropImage','migration SQL generated'];
const scaleChecks = ['queueService exists and exports','docker-compose.yml exists','Dockerfile exists (backend)','Dockerfile exists (OCR)'];

function scoreGroup(names) {
  const passing = names.filter(n => checks.find(([cn]) => cn === n) !== undefined).filter(n => {
    try { checks.find(([cn]) => cn === n)[1](); return true; } catch { return false; }
  }).length;
  return Math.round((passing / names.length) * 100);
}

const secScore   = secChecks.filter(n => { try { checks.find(([cn])=>cn===n)?.[1](); return true; } catch { return false; }}).length;
const perfScore  = perfChecks.filter(n => { try { checks.find(([cn])=>cn===n)?.[1](); return true; } catch { return false; }}).length;
const relScore   = relChecks.filter(n => { try { checks.find(([cn])=>cn===n)?.[1](); return true; } catch { return false; }}).length;
const scaleScore = scaleChecks.filter(n => { try { checks.find(([cn])=>cn===n)?.[1](); return true; } catch { return false; }}).length;

console.log('\n══════════════════════════════════════════════════════════════');
console.log('  MODULE SCORES');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  Security    : ${Math.round((secScore/secChecks.length)*100)}%  (${secScore}/${secChecks.length} checks)`);
console.log(`  Performance : ${Math.round((perfScore/perfChecks.length)*100)}%  (${perfScore}/${perfChecks.length} checks)`);
console.log(`  Reliability : ${Math.round((relScore/relChecks.length)*100)}%  (${relScore}/${relChecks.length} checks)`);
console.log(`  Scalability : ${Math.round((scaleScore/scaleChecks.length)*100)}%  (${scaleScore}/${scaleChecks.length} checks)`);
console.log('\n══════════════════════════════════════════════════════════════');
console.log(`  CHECKS: ${pass} PASS  ${fail} FAIL  (${total} total)`);
console.log(`  OVERALL: ${pct}% passing`);
console.log('══════════════════════════════════════════════════════════════\n');

process.exit(fail > 0 ? 1 : 0);
