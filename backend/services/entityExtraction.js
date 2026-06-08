/**
 * Entity Extraction Engine
 * ------------------------
 * Turns raw OCR text from one card into structured fields + multiple contacts.
 *
 * Approach: deterministic, explainable extraction (regex + heuristics + a small
 * dictionary of designation/department/industry keywords). Results are
 * reproducible and auditable.
 *
 * Indian-context aware: GSTIN, +91 mobiles, common Indian city/state hints.
 */

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const GSTIN_RE = /\b\d{2}[A-Z]{5}\d{4}[A-Z]{1}[A-Z\d]{1}Z[A-Z\d]{1}\b/g;
const URL_RE =
  /\b((?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s]*)?)\b/gi;
const PHONE_RE =
  /(?:(?:\+|00)\d{1,3}[\s-]?)?(?:\(\d{1,4}\)[\s-]?)?\d(?:[\d\s-]{6,14}\d)/g;
const POSTAL_RE = /\b\d{6}\b/;
const POSTAL_RE_LOOSE = /\b\d{5,6}\b/;

const SOCIAL = {
  linkedin: /((?:https?:\/\/)?(?:www\.)?linkedin\.com\/[^\s]+|in\/[A-Za-z0-9-]+)/i,
  twitter: /((?:https?:\/\/)?(?:www\.)?(?:twitter|x)\.com\/[^\s]+|@[A-Za-z0-9_]{2,})/i,
  facebook: /((?:https?:\/\/)?(?:www\.)?facebook\.com\/[^\s]+)/i,
  instagram: /((?:https?:\/\/)?(?:www\.)?instagram\.com\/[^\s]+)/i,
  youtube: /((?:https?:\/\/)?(?:www\.)?youtube\.com\/[^\s]+)/i,
  whatsapp: /(?:whatsapp|wa\.me)[:\s/]*([+\d][\d\s-]{7,})/i,
};

const DESIGNATION_KEYWORDS = [
  "ceo", "cto", "cfo", "coo", "founder", "co-founder", "director",
  "managing director", "president", "vice president", "vp", "head",
  "manager", "senior manager", "general manager", "gm", "engineer",
  "senior engineer", "lead", "executive", "officer", "proprietor",
  "partner", "owner", "consultant", "analyst", "architect", "specialist",
  "sales manager", "accounts manager", "marketing director", "product manager",
];

const DEPARTMENT_KEYWORDS = [
  "sales", "marketing", "accounts", "finance", "operations", "production",
  "purchase", "procurement", "hr", "human resources", "it", "engineering",
  "quality", "logistics", "design", "r&d", "research",
];

const COMPANY_SUFFIXES = [
  "pvt", "private", "ltd", "limited", "llp", "llc", "inc", "incorporated",
  "corp", "corporation", "co", "company", "industries", "enterprises",
  "technologies", "solutions", "systems", "group", "gmbh", "plc",
];

// ── Industry keyword dictionary ──────────────────────────────────────────────
// Maps trigger keywords (found anywhere in the card text) to an industry label.
// Ordered by specificity — more specific entries first.
const INDUSTRY_KEYWORDS = [
  // Manufacturing & Engineering
  { keywords: ["cnc", "machining", "precision machining", "turning", "milling"], industry: "Precision Machining" },
  { keywords: ["sheet metal", "fabrication", "stamping", "metal forming"], industry: "Sheet Metal Fabrication" },
  { keywords: ["casting", "foundry", "die casting", "investment casting"], industry: "Casting & Foundry" },
  { keywords: ["forging", "forge", "hot forging", "cold forging"], industry: "Forging" },
  { keywords: ["welding", "weldment", "welded assembly"], industry: "Welding & Assembly" },
  { keywords: ["injection moulding", "injection molding", "plastics", "polymer"], industry: "Plastics & Polymers" },
  { keywords: ["rubber", "seals", "gaskets", "o-ring"], industry: "Rubber & Seals" },
  { keywords: ["tooling", "tool room", "jigs", "fixtures", "moulds", "molds"], industry: "Tooling & Fixtures" },
  { keywords: ["automation", "robotics", "conveyor", "material handling"], industry: "Automation & Robotics" },
  { keywords: ["hydraulic", "pneumatic", "cylinders", "valves"], industry: "Hydraulics & Pneumatics" },
  { keywords: ["bearing", "linear motion", "ball screw", "spindle"], industry: "Bearings & Motion" },
  { keywords: ["cutting tools", "inserts", "carbide", "abrasives", "grinding"], industry: "Cutting Tools & Abrasives" },
  { keywords: ["metrology", "cmm", "inspection", "gauges", "measurement"], industry: "Metrology & Inspection" },
  { keywords: ["heat treatment", "hardening", "annealing", "tempering"], industry: "Heat Treatment" },
  { keywords: ["surface treatment", "plating", "coating", "anodising", "electroplating"], industry: "Surface Treatment" },
  { keywords: ["aerospace", "aviation", "aircraft"], industry: "Aerospace" },
  { keywords: ["automotive", "automobile", "auto components", "tier 1", "tier-1"], industry: "Automotive" },
  { keywords: ["defence", "defense", "ordnance", "military"], industry: "Defence" },
  { keywords: ["medical device", "surgical", "implant", "orthopaedic"], industry: "Medical Devices" },
  { keywords: ["electronics", "pcb", "semiconductor", "electronic"], industry: "Electronics" },
  { keywords: ["oil & gas", "oil and gas", "petroleum", "refinery"], industry: "Oil & Gas" },
  { keywords: ["power", "energy", "wind", "solar", "turbine"], industry: "Energy & Power" },
  { keywords: ["construction", "infrastructure", "civil", "structural steel"], industry: "Construction" },
  { keywords: ["food processing", "food machinery", "packaging machinery"], industry: "Food Processing" },
  { keywords: ["textile", "spinning", "weaving", "yarn"], industry: "Textiles" },
  { keywords: ["chemical", "pharma", "pharmaceutical"], industry: "Chemicals & Pharma" },
  { keywords: ["it services", "software", "saas", "cloud", "technology"], industry: "IT & Technology" },
  { keywords: ["trading", "distribution", "wholesale", "import", "export"], industry: "Trading & Distribution" },
  { keywords: ["engineering services", "design services", "cad", "cam"], industry: "Engineering Services" },
  { keywords: ["general engineering", "engineering"], industry: "General Engineering" },
  { keywords: ["manufacturing"], industry: "Manufacturing" },
];

function cleanLine(s) {
  return s.replace(/\s+/g, " ").trim();
}

function firstMatch(re, text) {
  const m = text.match(re);
  return m ? m[0].trim() : null;
}

function looksLikeName(line) {
  const words = line.split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
  if (/\d/.test(line)) return false;
  const lower = line.toLowerCase();
  if (COMPANY_SUFFIXES.some((s) => lower.includes(s))) return false;
  if (DESIGNATION_KEYWORDS.some((d) => lower.includes(d))) return false;
  return words.every((w) => /^[A-Z][a-zA-Z.'-]*$/.test(w));
}

function looksLikeCompany(line) {
  const lower = line.toLowerCase();
  return COMPANY_SUFFIXES.some((s) =>
    new RegExp(`\\b${s}\\b\\.?`).test(lower)
  );
}

function findDesignation(line) {
  const lower = line.toLowerCase();
  const hit = DESIGNATION_KEYWORDS
    .filter((k) => new RegExp(`\\b${k.replace(/[&]/g, "\\&")}\\b`).test(lower))
    .sort((a, b) => b.length - a.length)[0];
  return hit ? cleanLine(line) : null;
}

function findDepartment(line) {
  const lower = line.toLowerCase();
  return DEPARTMENT_KEYWORDS.find((k) => new RegExp(`\\b${k}\\b`).test(lower)) || null;
}

/**
 * Infer industry from the full card text using the keyword dictionary.
 * Returns the first (most-specific) match, or null.
 */
function inferIndustry(text) {
  const lower = text.toLowerCase();
  for (const entry of INDUSTRY_KEYWORDS) {
    if (entry.keywords.some((kw) => lower.includes(kw))) {
      return entry.industry;
    }
  }
  return null;
}

function extractContacts(lines, allEmails, allPhones) {
  const contacts = [];
  for (let i = 0; i < lines.length; i++) {
    if (looksLikeName(lines[i])) {
      const next = lines[i + 1] || "";
      const desigOnCurrent = findDesignation(lines[i]);
      const desigOnNext = findDesignation(next);
      const designation = desigOnCurrent
        ? cleanLine(lines[i])
        : desigOnNext
        ? cleanLine(next)
        : null;
      contacts.push({
        fullName: cleanLine(lines[i]),
        designation,
        department: findDepartment(next),
        email: null,
        mobile: null,
        phone: null,
        isPrimary: contacts.length === 0,
      });
    }
  }
  if (contacts.length === 0) {
    contacts.push({
      fullName: null, designation: null, department: null,
      email: null, mobile: null, phone: null, isPrimary: true,
    });
  }
  if (allEmails[0]) contacts[0].email = allEmails[0];
  if (allPhones[0]) contacts[0].mobile = allPhones[0];
  if (allPhones[1]) contacts[0].phone = allPhones[1];
  for (let c = 1; c < contacts.length; c++) {
    if (allEmails[c]) contacts[c].email = allEmails[c];
    if (allPhones[c + 1]) contacts[c].mobile = allPhones[c + 1];
  }
  return contacts;
}

function normalizePhone(p) {
  const digits = p.replace(/[^\d+]/g, "");
  return digits.length >= 8 ? p.trim() : null;
}

function extractEntities(rawText) {
  const text = rawText || "";
  const lines = text
    .split(/\r?\n/)
    .map(cleanLine)
    .filter(Boolean);

  const emails = [
    ...new Set((text.match(EMAIL_RE) || []).map((e) => e.toLowerCase())),
  ];
  const phones = [
    ...new Set((text.match(PHONE_RE) || []).map(normalizePhone).filter(Boolean)),
  ].filter(
    (p, _, arr) =>
      !arr.some(
        (o) => o !== p && o.replace(/\D/g, "").includes(p.replace(/\D/g, ""))
      )
  );

  const gstin = firstMatch(GSTIN_RE, text.toUpperCase());

  const emailLocals = emails.map((e) => e.split("@")[0]);
  const urls = (text.match(URL_RE) || [])
    .map((u) => u.trim())
    .filter((u) => !u.includes("@"))
    .filter((u) => {
      const bare = u.replace(/^https?:\/\//, "").replace(/^www\./, "");
      return !emailLocals.some((loc) => loc.includes(bare));
    });

  const social = {};
  for (const [k, re] of Object.entries(SOCIAL)) {
    const m = text.match(re);
    if (m) social[k] = m[1] || m[0];
  }
  const website =
    urls.find((u) => !Object.values(social).some((s) => s && s.includes(u))) ||
    null;

  let companyName =
    lines.find(looksLikeCompany) ||
    lines
      .slice(0, 4)
      .filter((l) => l === l.toUpperCase() && l.length > 3)
      .sort((a, b) => b.length - a.length)[0] ||
    null;

  const isPhoneLine = (l) => {
    const digits = l.replace(/\D/g, "");
    const alpha = l.replace(/[^A-Za-z]/g, "");
    return digits.length >= 8 && alpha.length <= 3;
  };

  const addressLines = lines.filter(
    (l) =>
      !isPhoneLine(l) &&
      !/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(l) &&
      (POSTAL_RE.test(l) ||
        /\b(road|street|st\.|lane|nagar|park|plot|sector|block|floor|suite|tower|estate|industrial|area|phase|midc|gidc|hsiidc|sidco)\b/i.test(
          l
        ))
  );
  const address = addressLines.length ? addressLines.join(", ") : null;
  const postalCode = address
    ? firstMatch(POSTAL_RE, address) || firstMatch(POSTAL_RE_LOOSE, address)
    : null;

  // ── Industry: infer from full card text ─────────────────────────────────
  const industry = inferIndustry(text);

  const contacts = extractContacts(lines, emails, phones);

  return {
    companyName,
    website,
    email: emails[0] || null,
    phonePrimary: phones[0] || null,
    phoneSecondary: phones[1] || null,
    address,
    postalCode,
    gstin,
    industry,          // ← now populated from keyword dictionary
    linkedin: social.linkedin || null,
    twitter: social.twitter || null,
    facebook: social.facebook || null,
    instagram: social.instagram || null,
    youtube: social.youtube || null,
    whatsapp: social.whatsapp || null,
    // city/state/country resolved by validation.js
    city: null,
    state: null,
    country: null,
    contacts,
    _debug: { lineCount: lines.length, emails, phones },
  };
}

module.exports = { extractEntities, inferIndustry };
