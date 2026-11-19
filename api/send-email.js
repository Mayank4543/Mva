import nodemailer from "nodemailer";

const LEADPROSPER_URL = "https://api.leadprosper.io/direct_post";
const LP_CAMPAIGN_ID = "31080";
const LP_SUPPLIER_ID = "137886";
const LP_KEY = "y70jclz6ns525l";

function digitsOnly(value) {
  return (value || "").toString().replace(/\D/g, "");
}

function getRealIp(req) {
  const sources = [
    req.headers["x-forwarded-for"],
    req.headers["x-real-ip"],
    req.headers["cf-connecting-ip"],
  ];

  for (const source of sources) {
    if (!source) continue;
    for (const candidate of source.split(",")) {
      const ip = candidate.trim();
      if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) continue;
      const [a, b] = ip.split(".").map(Number);
      if (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) continue;
      return ip;
    }
  }
  return "";
}

async function sendLeadEmail(lead, lpResponse, error = "") {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    return { sent: false, reason: "EMAIL_USER or EMAIL_PASS environment variable is missing" };
  }

  const status = lpResponse?.status || (error ? "ERROR" : "UNKNOWN");
  const leadDetails = Object.entries(lead)
    .map(([key, value]) => `${key.padEnd(24)}: ${value || "—"}`)
    .join("\n");

  const message = `
LEADPROSPER STATUS: ${status}

━━━ LEAD DATA ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${leadDetails}

━━━ LEADPROSPER RESPONSE ━━━━━━━━━━━━━━━━━━━━━━━━━
${lpResponse ? JSON.stringify(lpResponse, null, 2) : "—"}

${error ? `━━━ ERROR ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${error}\n` : ""}
`.trim();

  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: (process.env.EMAIL_PASS || "").replace(/\s+/g, ""),
      },
    });

    const info = await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: process.env.LEAD_RECEIVER_EMAIL || "codemynk234@gmail.com",
      subject: `LeadProsper ${status} – ${lead.first_name} ${lead.last_name}`,
      text: message,
    });

    return { sent: true, messageId: info.messageId };
  } catch (emailError) {
    console.error("Failed to send lead email:", emailError);
    return { sent: false, error: emailError.message };
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let lead = {};

  try {
    const data = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const errors = {};

    const phone = digitsOnly(data.phone);
    if (phone.length !== 10) errors.phone = "is required and must contain exactly 10 digits";
    if (!data.first_name) errors.first_name = "is required";
    if (!data.last_name) errors.last_name = "is required";
    if (!data.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
      errors.email = "is required and must be a valid email address";
    }
    if (!data.date_of_birth || !/^\d{4}-\d{2}-\d{2}$/.test(data.date_of_birth)) {
      errors.date_of_birth = "is required in YYYY-MM-DD format";
    }
    if (!data.city) errors.city = "is required";
    if (!/^[A-Z]{2}$/.test((data.state || "").toUpperCase())) {
      errors.state = "is required and must be a 2-letter US state code";
    }
    if (!/^\d{5}$/.test(String(data.zip_code || ""))) {
      errors.zip_code = "is required and must contain 5 digits";
    }
    if (!data.landing_page_url) {
      errors.landing_page_url = "is required";
    }
    if (!data.incident_state) errors.incident_state = "is required";
    if (!data.incident_date || !/^\d{2}\/\d{2}\/\d{4}$/.test(data.incident_date)) {
      errors.incident_date = "is required in MM/DD/YYYY format";
    }
    for (const field of ["have_attorney", "at_fault", "doctor_treatment", "physical_injury"]) {
      if (!["Yes", "No"].includes(data[field])) {
        errors[field] = "is required and must be Yes or No";
      }
    }
    if (!data.jornaya_leadid && !data.trustedform_cert_url) {
      errors.verification = "Jornaya Lead ID or TrustedForm Certificate URL is required";
    }

    if (Object.keys(errors).length) {
      return res.status(400).json({ status: "ERROR", errors });
    }

    const ipAddress = getRealIp(req);
    lead = {
      lp_campaign_id: LP_CAMPAIGN_ID,
      lp_supplier_id: LP_SUPPLIER_ID,
      lp_key: LP_KEY,
      first_name: data.first_name,
      last_name: data.last_name,
      email: data.email,
      phone,
      date_of_birth: data.date_of_birth,
      city: data.city,
      state: data.state.toUpperCase(),
      zip_code: String(data.zip_code),
      ip_address: ipAddress,
      landing_page_url: data.landing_page_url,
      jornaya_leadid: data.jornaya_leadid || "",
      trustedform_cert_url: data.trustedform_cert_url || "",
      incident_state: data.incident_state,
      incident_date: data.incident_date,
      have_attorney: data.have_attorney,
      at_fault: data.at_fault,
      doctor_treatment: data.doctor_treatment,
      physical_injury: data.physical_injury,
    };

    const lpRes = await fetch(LEADPROSPER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(lead),
    });

    let lpResponse;
    const responseText = await lpRes.text();
    try {
      lpResponse = JSON.parse(responseText);
    } catch {
      lpResponse = { status: lpRes.ok ? "ERROR" : `HTTP_${lpRes.status}`, message: responseText };
    }

    const emailStatus = await sendLeadEmail(lead, lpResponse);
    return res.status(lpRes.ok ? 200 : lpRes.status).json({
      ...lpResponse,
      emailStatus,
    });
  } catch (error) {
    console.error("LeadProsper handler error:", error);
    const lpResponse = { status: "ERROR", message: error.message };
    const emailStatus = await sendLeadEmail(lead, lpResponse, error.message);
    return res.status(500).json({ status: "ERROR", message: "Internal server error", emailStatus });
  }
}
