/**
 * Validation Engine
 * -----------------
 * Validates each extracted field and assigns a 0..1 confidence. Also resolves
 * city / state / country from the address using a comprehensive dictionary
 * covering all 28 Indian states + 8 UTs, 100+ major cities, and GST state codes.
 *
 * Output shape per field: { value, valid, confidence, reason? }
 * Plus an overall lead confidence = weighted mean of field confidences.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z]{1}[A-Z\d]{1}Z[A-Z\d]{1}$/;

// ── GST State Code → State Name (all 36 codes) ───────────────────────────────
const GST_STATE_CODES = {
  "01": "Jammu & Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  "10": "Bihar",
  "11": "Sikkim",
  "12": "Arunachal Pradesh",
  "13": "Nagaland",
  "14": "Manipur",
  "15": "Mizoram",
  "16": "Tripura",
  "17": "Meghalaya",
  "18": "Assam",
  "19": "West Bengal",
  "20": "Jharkhand",
  "21": "Odisha",
  "22": "Chhattisgarh",
  "23": "Madhya Pradesh",
  "24": "Gujarat",
  "25": "Daman & Diu",
  "26": "Dadra & Nagar Haveli",
  "27": "Maharashtra",
  "28": "Andhra Pradesh",
  "29": "Karnataka",
  "30": "Goa",
  "31": "Lakshadweep",
  "32": "Kerala",
  "33": "Tamil Nadu",
  "34": "Puducherry",
  "35": "Andaman & Nicobar Islands",
  "36": "Telangana",
  "37": "Andhra Pradesh",
  "38": "Ladakh",
  "97": "Other Territory",
  "99": "Centre Jurisdiction",
};

// ── State hints: keyword → { state, country } ───────────────────────────────
const STATE_HINTS = {
  // All 28 states
  "andhra pradesh":       { state: "Andhra Pradesh",        country: "India" },
  "arunachal pradesh":    { state: "Arunachal Pradesh",     country: "India" },
  "assam":                { state: "Assam",                 country: "India" },
  "bihar":                { state: "Bihar",                 country: "India" },
  "chhattisgarh":         { state: "Chhattisgarh",          country: "India" },
  "goa":                  { state: "Goa",                   country: "India" },
  "gujarat":              { state: "Gujarat",               country: "India" },
  "haryana":              { state: "Haryana",               country: "India" },
  "himachal pradesh":     { state: "Himachal Pradesh",      country: "India" },
  "jharkhand":            { state: "Jharkhand",             country: "India" },
  "karnataka":            { state: "Karnataka",             country: "India" },
  "kerala":               { state: "Kerala",                country: "India" },
  "madhya pradesh":       { state: "Madhya Pradesh",        country: "India" },
  "maharashtra":          { state: "Maharashtra",           country: "India" },
  "manipur":              { state: "Manipur",               country: "India" },
  "meghalaya":            { state: "Meghalaya",             country: "India" },
  "mizoram":              { state: "Mizoram",               country: "India" },
  "nagaland":             { state: "Nagaland",              country: "India" },
  "odisha":               { state: "Odisha",                country: "India" },
  "orissa":               { state: "Odisha",                country: "India" },
  "punjab":               { state: "Punjab",                country: "India" },
  "rajasthan":            { state: "Rajasthan",             country: "India" },
  "sikkim":               { state: "Sikkim",                country: "India" },
  "tamil nadu":           { state: "Tamil Nadu",            country: "India" },
  "tamilnadu":            { state: "Tamil Nadu",            country: "India" },
  "telangana":            { state: "Telangana",             country: "India" },
  "tripura":              { state: "Tripura",               country: "India" },
  "uttar pradesh":        { state: "Uttar Pradesh",         country: "India" },
  "u.p.":                 { state: "Uttar Pradesh",         country: "India" },
  "uttarakhand":          { state: "Uttarakhand",           country: "India" },
  "uttaranchal":          { state: "Uttarakhand",           country: "India" },
  "west bengal":          { state: "West Bengal",           country: "India" },
  // UTs
  "delhi":                { state: "Delhi",                 country: "India" },
  "new delhi":            { state: "Delhi",                 country: "India" },
  "chandigarh":           { state: "Chandigarh",            country: "India" },
  "puducherry":           { state: "Puducherry",            country: "India" },
  "pondicherry":          { state: "Puducherry",            country: "India" },
  "jammu":                { state: "Jammu & Kashmir",       country: "India" },
  "kashmir":              { state: "Jammu & Kashmir",       country: "India" },
  "ladakh":               { state: "Ladakh",                country: "India" },
  "dadra":                { state: "Dadra & Nagar Haveli",  country: "India" },
  "daman":                { state: "Daman & Diu",           country: "India" },
  "lakshadweep":          { state: "Lakshadweep",           country: "India" },
  "andaman":              { state: "Andaman & Nicobar Islands", country: "India" },
};

// ── City hints: keyword → { city, state, country } ──────────────────────────
const CITY_HINTS = {
  // Maharashtra
  "mumbai":         { city: "Mumbai",         state: "Maharashtra",  country: "India" },
  "pune":           { city: "Pune",           state: "Maharashtra",  country: "India" },
  "nagpur":         { city: "Nagpur",         state: "Maharashtra",  country: "India" },
  "nashik":         { city: "Nashik",         state: "Maharashtra",  country: "India" },
  "aurangabad":     { city: "Aurangabad",     state: "Maharashtra",  country: "India" },
  "solapur":        { city: "Solapur",        state: "Maharashtra",  country: "India" },
  "kolhapur":       { city: "Kolhapur",       state: "Maharashtra",  country: "India" },
  "thane":          { city: "Thane",          state: "Maharashtra",  country: "India" },
  "pimpri":         { city: "Pimpri-Chinchwad", state: "Maharashtra", country: "India" },
  "chinchwad":      { city: "Pimpri-Chinchwad", state: "Maharashtra", country: "India" },
  "navi mumbai":    { city: "Navi Mumbai",    state: "Maharashtra",  country: "India" },
  "satara":         { city: "Satara",         state: "Maharashtra",  country: "India" },
  "sangli":         { city: "Sangli",         state: "Maharashtra",  country: "India" },
  "amravati":       { city: "Amravati",       state: "Maharashtra",  country: "India" },
  // Gujarat
  "ahmedabad":      { city: "Ahmedabad",      state: "Gujarat",      country: "India" },
  "surat":          { city: "Surat",          state: "Gujarat",      country: "India" },
  "vadodara":       { city: "Vadodara",       state: "Gujarat",      country: "India" },
  "baroda":         { city: "Vadodara",       state: "Gujarat",      country: "India" },
  "rajkot":         { city: "Rajkot",         state: "Gujarat",      country: "India" },
  "gandhinagar":    { city: "Gandhinagar",    state: "Gujarat",      country: "India" },
  "bhavnagar":      { city: "Bhavnagar",      state: "Gujarat",      country: "India" },
  "jamnagar":       { city: "Jamnagar",       state: "Gujarat",      country: "India" },
  "anand":          { city: "Anand",          state: "Gujarat",      country: "India" },
  "morbi":          { city: "Morbi",          state: "Gujarat",      country: "India" },
  // Karnataka
  "bangalore":      { city: "Bangalore",      state: "Karnataka",    country: "India" },
  "bengaluru":      { city: "Bengaluru",      state: "Karnataka",    country: "India" },
  "mysore":         { city: "Mysore",         state: "Karnataka",    country: "India" },
  "mysuru":         { city: "Mysuru",         state: "Karnataka",    country: "India" },
  "hubli":          { city: "Hubli",          state: "Karnataka",    country: "India" },
  "dharwad":        { city: "Dharwad",        state: "Karnataka",    country: "India" },
  "mangalore":      { city: "Mangalore",      state: "Karnataka",    country: "India" },
  "belgaum":        { city: "Belagavi",       state: "Karnataka",    country: "India" },
  "belagavi":       { city: "Belagavi",       state: "Karnataka",    country: "India" },
  "tumkur":         { city: "Tumkur",         state: "Karnataka",    country: "India" },
  // Tamil Nadu
  "chennai":        { city: "Chennai",        state: "Tamil Nadu",   country: "India" },
  "madras":         { city: "Chennai",        state: "Tamil Nadu",   country: "India" },
  "coimbatore":     { city: "Coimbatore",     state: "Tamil Nadu",   country: "India" },
  "madurai":        { city: "Madurai",        state: "Tamil Nadu",   country: "India" },
  "tiruchirappalli":{ city: "Tiruchirappalli",state: "Tamil Nadu",   country: "India" },
  "trichy":         { city: "Tiruchirappalli",state: "Tamil Nadu",   country: "India" },
  "salem":          { city: "Salem",          state: "Tamil Nadu",   country: "India" },
  "tirunelveli":    { city: "Tirunelveli",    state: "Tamil Nadu",   country: "India" },
  "erode":          { city: "Erode",          state: "Tamil Nadu",   country: "India" },
  "tirupur":        { city: "Tirupur",        state: "Tamil Nadu",   country: "India" },
  "vellore":        { city: "Vellore",        state: "Tamil Nadu",   country: "India" },
  // Telangana
  "hyderabad":      { city: "Hyderabad",      state: "Telangana",    country: "India" },
  "secunderabad":   { city: "Secunderabad",   state: "Telangana",    country: "India" },
  "warangal":       { city: "Warangal",       state: "Telangana",    country: "India" },
  // Andhra Pradesh
  "visakhapatnam":  { city: "Visakhapatnam",  state: "Andhra Pradesh", country: "India" },
  "vizag":          { city: "Visakhapatnam",  state: "Andhra Pradesh", country: "India" },
  "vijayawada":     { city: "Vijayawada",     state: "Andhra Pradesh", country: "India" },
  "guntur":         { city: "Guntur",         state: "Andhra Pradesh", country: "India" },
  // Delhi / NCR
  "delhi":          { city: "Delhi",          state: "Delhi",        country: "India" },
  "new delhi":      { city: "New Delhi",      state: "Delhi",        country: "India" },
  "noida":          { city: "Noida",          state: "Uttar Pradesh",country: "India" },
  "gurgaon":        { city: "Gurgaon",        state: "Haryana",      country: "India" },
  "gurugram":       { city: "Gurugram",       state: "Haryana",      country: "India" },
  "faridabad":      { city: "Faridabad",      state: "Haryana",      country: "India" },
  "ghaziabad":      { city: "Ghaziabad",      state: "Uttar Pradesh",country: "India" },
  // Rajasthan
  "jaipur":         { city: "Jaipur",         state: "Rajasthan",    country: "India" },
  "jodhpur":        { city: "Jodhpur",        state: "Rajasthan",    country: "India" },
  "udaipur":        { city: "Udaipur",        state: "Rajasthan",    country: "India" },
  "kota":           { city: "Kota",           state: "Rajasthan",    country: "India" },
  "ajmer":          { city: "Ajmer",          state: "Rajasthan",    country: "India" },
  // Madhya Pradesh
  "bhopal":         { city: "Bhopal",         state: "Madhya Pradesh", country: "India" },
  "indore":         { city: "Indore",         state: "Madhya Pradesh", country: "India" },
  "jabalpur":       { city: "Jabalpur",       state: "Madhya Pradesh", country: "India" },
  "gwalior":        { city: "Gwalior",        state: "Madhya Pradesh", country: "India" },
  "ujjain":         { city: "Ujjain",         state: "Madhya Pradesh", country: "India" },
  // Uttar Pradesh
  "lucknow":        { city: "Lucknow",        state: "Uttar Pradesh",country: "India" },
  "kanpur":         { city: "Kanpur",         state: "Uttar Pradesh",country: "India" },
  "agra":           { city: "Agra",           state: "Uttar Pradesh",country: "India" },
  "varanasi":       { city: "Varanasi",       state: "Uttar Pradesh",country: "India" },
  "allahabad":      { city: "Prayagraj",      state: "Uttar Pradesh",country: "India" },
  "prayagraj":      { city: "Prayagraj",      state: "Uttar Pradesh",country: "India" },
  "meerut":         { city: "Meerut",         state: "Uttar Pradesh",country: "India" },
  // West Bengal
  "kolkata":        { city: "Kolkata",        state: "West Bengal",  country: "India" },
  "calcutta":       { city: "Kolkata",        state: "West Bengal",  country: "India" },
  "howrah":         { city: "Howrah",         state: "West Bengal",  country: "India" },
  "durgapur":       { city: "Durgapur",       state: "West Bengal",  country: "India" },
  // Punjab / Haryana / Chandigarh
  "chandigarh":     { city: "Chandigarh",     state: "Chandigarh",   country: "India" },
  "ludhiana":       { city: "Ludhiana",       state: "Punjab",       country: "India" },
  "amritsar":       { city: "Amritsar",       state: "Punjab",       country: "India" },
  "jalandhar":      { city: "Jalandhar",      state: "Punjab",       country: "India" },
  "ambala":         { city: "Ambala",         state: "Haryana",      country: "India" },
  "rohtak":         { city: "Rohtak",         state: "Haryana",      country: "India" },
  "panipat":        { city: "Panipat",        state: "Haryana",      country: "India" },
  // Bihar / Jharkhand
  "patna":          { city: "Patna",          state: "Bihar",        country: "India" },
  "ranchi":         { city: "Ranchi",         state: "Jharkhand",    country: "India" },
  "jamshedpur":     { city: "Jamshedpur",     state: "Jharkhand",    country: "India" },
  // Odisha
  "bhubaneswar":    { city: "Bhubaneswar",    state: "Odisha",       country: "India" },
  "cuttack":        { city: "Cuttack",        state: "Odisha",       country: "India" },
  // Assam
  "guwahati":       { city: "Guwahati",       state: "Assam",        country: "India" },
  // Kerala
  "thiruvananthapuram": { city: "Thiruvananthapuram", state: "Kerala", country: "India" },
  "trivandrum":     { city: "Thiruvananthapuram", state: "Kerala",   country: "India" },
  "kochi":          { city: "Kochi",          state: "Kerala",       country: "India" },
  "cochin":         { city: "Kochi",          state: "Kerala",       country: "India" },
  "kozhikode":      { city: "Kozhikode",      state: "Kerala",       country: "India" },
  "calicut":        { city: "Kozhikode",      state: "Kerala",       country: "India" },
  // Goa
  "panaji":         { city: "Panaji",         state: "Goa",          country: "India" },
  "margao":         { city: "Margao",         state: "Goa",          country: "India" },
  // International
  "dubai":          { city: "Dubai",          state: null,           country: "UAE" },
  "abu dhabi":      { city: "Abu Dhabi",      state: null,           country: "UAE" },
  "singapore":      { city: "Singapore",      state: null,           country: "Singapore" },
  "new york":       { city: "New York",       state: "NY",           country: "USA" },
  "london":         { city: "London",         state: null,           country: "UK" },
  "frankfurt":      { city: "Frankfurt",      state: null,           country: "Germany" },
  "tokyo":          { city: "Tokyo",          state: null,           country: "Japan" },
  "shanghai":       { city: "Shanghai",       state: null,           country: "China" },
};

// ── Field validators ─────────────────────────────────────────────────────────

function scoreEmail(v) {
  if (!v) return { value: null, valid: false, confidence: 0 };
  const valid = EMAIL_RE.test(v);
  const generic = /^(info|sales|contact|admin|office|support|hello|enquiry|inquiry)@/i.test(v);
  return { value: v, valid, confidence: valid ? (generic ? 0.7 : 0.99) : 0.2 };
}

function scorePhone(v) {
  if (!v) return { value: null, valid: false, confidence: 0 };
  const digits = v.replace(/\D/g, "");
  const valid = digits.length >= 8 && digits.length <= 15;
  return { value: v, valid, confidence: valid ? 0.95 : 0.3 };
}

function scoreWebsite(v) {
  if (!v) return { value: null, valid: false, confidence: 0 };
  const valid = /^[a-z0-9-]+(\.[a-z0-9-]+)+/i.test(
    v.replace(/^https?:\/\//, "").replace(/^www\./, "")
  );
  return { value: v, valid, confidence: valid ? 0.9 : 0.3 };
}

function scoreGstin(v) {
  if (!v) return { value: null, valid: false, confidence: 0 };
  const valid = GSTIN_RE.test(v);
  return {
    value: v,
    valid,
    confidence: valid ? 0.98 : 0.25,
    reason: valid ? undefined : "Does not match GSTIN format (15 chars: 2-digit state + 10-char PAN + 3)",
  };
}

function scoreLinkedin(v) {
  if (!v) return { value: null, valid: false, confidence: 0 };
  const valid = /linkedin\.com\/(in|company)\//i.test(v) || /^in\//i.test(v);
  return { value: v, valid, confidence: valid ? 0.9 : 0.5 };
}

function scorePostal(v) {
  if (!v) return { value: null, valid: false, confidence: 0 };
  const valid = /^\d{5,6}$/.test(v);
  return { value: v, valid, confidence: valid ? 0.85 : 0.4 };
}

/**
 * Resolve city / state / country from the address text.
 * Priority: city lookup (most specific) → state lookup → GSTIN state code.
 */
function resolveGeo(entities) {
  const hay = `${entities.address || ""} ${entities.city || ""} ${entities.state || ""}`.toLowerCase();
  let city = entities.city || null;
  let state = entities.state || null;
  let country = entities.country || null;

  // City lookup (gives us city + state + country in one shot)
  for (const [k, val] of Object.entries(CITY_HINTS)) {
    if (hay.includes(k)) {
      city = city || val.city;
      state = state || val.state;
      country = country || val.country;
      break;
    }
  }

  // State-only lookup if still missing
  if (!state) {
    for (const [k, val] of Object.entries(STATE_HINTS)) {
      if (hay.includes(k)) {
        state = val.state;
        country = country || val.country;
        break;
      }
    }
  }

  // GSTIN state code is authoritative for state + country
  if (entities.gstin && GSTIN_RE.test(entities.gstin)) {
    const code = entities.gstin.slice(0, 2);
    if (GST_STATE_CODES[code]) {
      state = GST_STATE_CODES[code];
      country = country || "India";
    }
  }

  // Default country to India for +91 numbers
  if (!country && entities.phonePrimary && entities.phonePrimary.includes("+91")) {
    country = "India";
  }

  return {
    city: city || null,
    state: state || null,
    country: country || null,
  };
}

function validateLead(entities) {
  const fields = {
    email: scoreEmail(entities.email),
    phonePrimary: scorePhone(entities.phonePrimary),
    phoneSecondary: scorePhone(entities.phoneSecondary),
    website: scoreWebsite(entities.website),
    gstin: scoreGstin(entities.gstin),
    linkedin: scoreLinkedin(entities.linkedin),
    postalCode: scorePostal(entities.postalCode),
  };

  const geo = resolveGeo(entities);

  // Weighted confidence — only include fields that have a value
  const weights = {
    email: 2,
    phonePrimary: 2,
    website: 1,
    gstin: 1.5,
    phoneSecondary: 0.5,
    linkedin: 0.5,
    postalCode: 0.5,
  };
  let num = 0, den = 0;
  for (const [k, w] of Object.entries(weights)) {
    if (fields[k].value !== null) {
      num += fields[k].confidence * w;
      den += w;
    }
  }

  // Presence of company name + a person name adds baseline trust
  const hasCompany = !!entities.companyName;
  const hasName = (entities.contacts || []).some((c) => c.fullName);
  const base = (hasCompany ? 0.1 : 0) + (hasName ? 0.1 : 0);
  const overall = Math.min(1, base + (den ? (num / den) * 0.8 : 0));

  return {
    fields,
    geo,
    overallConfidence: Number(overall.toFixed(4)),
  };
}

module.exports = { validateLead, resolveGeo, GST_STATE_CODES };
