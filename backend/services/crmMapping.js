/**
 * Cosmos CRM Mapping Logic
 * ------------------------
 * Maps an internal Lead (+ its primary Contact + Company) to the EXACT column
 * set Cosmos CRM expects on import. Column order and names here are the single
 * source of truth used by exportService.js so CSV/XLSX/JSON all stay aligned.
 *
 * Fields Cosmos requires but that aren't on a business card (SAP Customer Code,
 * Account Status, Customer Type, Sales Branch, Rating, Assigned To) are filled
 * with sensible, configurable defaults — NOT fabricated data. They are left
 * blank or set to documented defaults so a CRM admin's import rules can take
 * over. Defaults live in config and can be overridden per export.
 */

// Canonical Cosmos CRM column order. DO NOT reorder without coordinating with
// the CRM import template.
const COSMOS_COLUMNS = [
  "Company Name",
  "SAP Customer Code",
  "Website",
  "Email",
  "Phone",
  "Account Status",
  "Customer Type",
  "Industry",
  "Sales Branch",
  "Rating",
  "City",
  "State",
  "GSTIN",
  "Assigned To",
  "Created At",
  "Updated At",
  "Contact Person",
  "Designation",
  "Mobile",
  "Address",
  "Country",
  "Postal Code",
  "LinkedIn",
];

const DEFAULTS = {
  accountStatus: "New Lead",      // documented default for freshly scanned leads
  customerType: "Prospect",
  rating: "",                     // left for CRM scoring rules
  salesBranch: "",                // set per event/source if known
  sapCustomerCode: "",            // assigned by SAP after import
  assignedTo: "",                 // round-robin/owner assignment happens in CRM
};

function fmt(dt) {
  if (!dt) return "";
  const d = new Date(dt);
  if (Number.isNaN(d.getTime())) return "";
  // YYYY-MM-DD HH:mm:ss to match the sample export's timestamp style.
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * @param {object} lead   Lead row (with company + contacts included)
 * @param {object} opts   { defaults?, salesBranchBySource? }
 * @returns {object}      keyed by COSMOS_COLUMNS
 */
function mapLeadToCosmos(lead, opts = {}) {
  const d = { ...DEFAULTS, ...(opts.defaults || {}) };
  const primary =
    (lead.contacts || []).find((c) => c.isPrimary) ||
    (lead.contacts || [])[0] ||
    {};

  // Sales branch can be derived from the event/source (e.g. "IMTEX 2026" ->
  // a configured branch). Falls back to default.
  const salesBranch =
    (opts.salesBranchBySource && lead.source &&
      opts.salesBranchBySource[lead.source]) ||
    d.salesBranch;

  return {
    "Company Name": lead.companyName || lead.company?.name || "",
    "SAP Customer Code": d.sapCustomerCode,
    "Website": lead.website || lead.company?.website || "",
    "Email": lead.email || primary.email || "",
    "Phone": lead.phonePrimary || primary.phone || "",
    "Account Status": d.accountStatus,
    "Customer Type": d.customerType,
    "Industry": lead.industry || lead.company?.industry || "",
    "Sales Branch": salesBranch,
    "Rating": d.rating,
    "City": lead.city || lead.company?.city || "",
    "State": lead.state || lead.company?.state || "",
    "GSTIN": lead.gstin || lead.company?.gstin || "",
    "Assigned To": d.assignedTo,
    "Created At": fmt(lead.createdAt),
    "Updated At": fmt(lead.updatedAt),
    "Contact Person": primary.fullName || "",
    "Designation": primary.designation || "",
    "Mobile": primary.mobile || lead.phoneSecondary || "",
    "Address": lead.address || "",
    "Country": lead.country || lead.company?.country || "",
    "Postal Code": lead.postalCode || lead.company?.postalCode || "",
    "LinkedIn": lead.linkedin || "",
  };
}

/**
 * Cards with multiple contacts: emit one CRM row per *additional* contact so no
 * person is lost, while keeping the company/address constant. The first contact
 * is the primary row above; this returns the extras.
 */
function mapAdditionalContacts(lead, opts = {}) {
  const extras = (lead.contacts || []).filter((c) => !c.isPrimary);
  return extras.map((c) => {
    const base = mapLeadToCosmos(lead, opts);
    return {
      ...base,
      "Email": c.email || "",
      "Phone": c.phone || "",
      "Contact Person": c.fullName || "",
      "Designation": c.designation || "",
      "Mobile": c.mobile || "",
    };
  });
}

module.exports = { COSMOS_COLUMNS, mapLeadToCosmos, mapAdditionalContacts, DEFAULTS };
