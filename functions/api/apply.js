// Cloudflare Pages Function: job application emailer via Resend.
//
// Settings (Pages project > Settings > Variables and Secrets):
//   RESEND_API_KEY  required. Secret. The Resend API key.
//   HR_TO           optional. Who receives applications. Default: hr@transcableusa.com
//                   (change this value any time; no code change or redeploy of code needed,
//                   just redeploy so the new value is picked up).
//   MAIL_FROM       optional. Sender shown on the email, e.g.
//                   "Trans Cable Careers <careers@transcableusa.com>".
//                   The address must be on a domain verified in Resend. Until then it falls
//                   back to Resend's test sender, which only delivers to the Resend account owner.

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
const MIN_FILL_MS = 3000; // faster than this = a bot, not a person

// Every field on the application form, grouped the way it appears in the email to HR.
// [key, label, max length]
const EMP = (i) => [
  [`emp${i}_name`, "Employer name", 150],
  [`emp${i}_position`, "Position held", 150],
  [`emp${i}_dates`, "Month & year (from / to)", 80],
  [`emp${i}_reason`, "Reason for leaving", 200],
  [`emp${i}_address`, "Address", 250],
  [`emp${i}_phone`, "Phone number", 40],
  [`emp${i}_contact`, "Person to contact", 120],
  [`emp${i}_contactPos`, "Contact's position", 120],
];
const REF = (i) => [
  [`ref${i}_name`, "Name / position", 150],
  [`ref${i}_company`, "Company name", 150],
  [`ref${i}_contact`, "Address / phone number", 250],
  [`ref${i}_years`, "Years acquainted", 40],
];
const SECTIONS = [
  ["APPLICANT", [
    ["name", "Applicant name", 120],
    ["email", "Applicant email", 200],
    ["phone", "Applicant home phone number", 40],
    ["address", "Applicant present address", 250],
    ["over18", "Are you at least 18 years old?", 10],
    ["background", "Authorizes background investigation (prior employers, education, criminal records)?", 10],
    ["terminated", "Ever involuntarily terminated by an employer?", 10],
  ]],
  ["POSITION DESIRED", [
    ["department", "Department", 40],
    ["otherDesired", "Other desired", 150],
    ["shift", "Shift preference", 10],
    ["status", "Status", 20],
    ["salary", "Salary expectations", 100],
    ["startDate", "Date available to start", 20],
    ["howHeard", "How did you hear about TCI?", 200],
    ["employed", "Currently employed?", 10],
    ["contactEmployer", "May we contact current employer?", 10],
    ["workedHere", "Employed by Trans Cable before?", 10],
  ]],
  ["EDUCATION", [
    ["hsSchool", "High school (name and location)", 200],
    ["hsLastYear", "Last year completed", 40],
    ["hsGrad", "Graduated (high school)?", 10],
    ["hsSubjects", "Subjects studied and degrees received", 500],
    ["collegeSchool", "College (name and location)", 200],
    ["collegeGrad", "Graduated (college)?", 10],
  ]],
  ...[1, 2, 3, 4].map((i) => [`EMPLOYER ${i}`, EMP(i)]),
  ["EXPERIENCE AND SKILLS", [
    ["describeWork", "Nature of work in present or most recent job", 3000],
    ["skills", "Special skills or knowledge (tools and machines)", 3000],
    ["certs", "Certifications or licenses", 3000],
  ]],
  ...[1, 2, 3].map((i) => [`REFERENCE ${i}`, REF(i)]),
  ["SIGNATURE", [
    ["signName", "Signed (typed full name)", 120],
    ["signDate", "Date", 20],
  ]],
];
const REQUIRED = ["name", "email", "phone", "address", "over18", "background", "terminated", "signName", "signDate"];

export async function onRequest(context) {
  if (context.request.method !== "POST") {
    return json({ ok: false, error: "method" }, 405);
  }

  let form;
  try {
    form = await context.request.formData();
  } catch {
    return json({ ok: false, error: "bad-form" }, 400);
  }

  // Spam traps: a hidden field real people never fill in, and a too-fast submit.
  if (String(form.get("website") ?? "").trim() !== "") {
    return json({ ok: true }); // pretend success so bots learn nothing
  }
  const startedAt = Number(form.get("startedAt"));
  if (Number.isFinite(startedAt) && startedAt > 0 && Date.now() - startedAt < MIN_FILL_MS) {
    return json({ ok: false, error: "too-fast" }, 400);
  }

  const data = {};
  for (const [, fields] of SECTIONS) {
    for (const [key, , max] of fields) {
      data[key] = String(form.get(key) ?? "").trim().slice(0, max);
    }
  }

  if (REQUIRED.some((k) => !data[k])) {
    return json({ ok: false, error: "missing-fields" }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
    return json({ ok: false, error: "invalid-email" }, 400);
  }

  // The resume is optional, but if one is attached it must be a real PDF or Word file.
  let attachments = [];
  let attachmentName = "";
  const file = form.get("resume");
  if (file && typeof file !== "string" && file.size) {
    if (file.size > MAX_FILE_BYTES) {
      return json({ ok: false, error: "file-too-large" }, 413);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const kind = detectResumeType(bytes, file.name);
    if (!kind) {
      return json({ ok: false, error: "bad-file-type" }, 415);
    }
    const safeName = data.name.replace(/[^A-Za-z0-9 ._-]/g, "").trim().replace(/\s+/g, "_") || "Applicant";
    attachmentName = `${safeName}_Resume.${kind}`;
    attachments = [{ filename: attachmentName, content: toBase64(bytes) }];
  }

  const apiKey = context.env.RESEND_API_KEY;
  const toEmail = context.env.HR_TO ?? "hr@transcableusa.com";
  const fromEmail = context.env.MAIL_FROM ?? "Trans Cable Careers <onboarding@resend.dev>";

  if (!apiKey) {
    return json(
      {
        ok: false,
        error: "not-configured",
        message:
          "The online application is not available right now. Please email your resume to hr@transcableusa.com.",
      },
      503,
    );
  }

  const lines = ["New online application from transcableusa.com", ""];
  for (const [title, fields] of SECTIONS) {
    const filled = fields.filter(([key]) => data[key]);
    // Skip empty optional blocks (for example an unused Employer 4) to keep the email short.
    if (!filled.length) continue;
    lines.push(`=== ${title} ===`);
    for (const [key, label] of filled) lines.push(`${label}: ${data[key]}`);
    lines.push("");
  }
  lines.push(attachmentName ? `Resume attached: ${attachmentName}` : "Resume: not attached");

  const subjectBits = [data.name, data.department].filter(Boolean).join(" - ");
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [toEmail],
        reply_to: data.email,
        subject: `Application: ${subjectBits}`,
        text: lines.join("\n"),
        ...(attachments.length ? { attachments } : {}),
      }),
    });
    if (!res.ok) return json({ ok: false, error: "send-failed", status: res.status }, 502);
    return json({ ok: true });
  } catch {
    return json({ ok: false, error: "send-failed" }, 502);
  }
}

// Accept only real PDF / Word files. Checks the file's first bytes, not just its name.
function detectResumeType(b, name) {
  const ext = String(name ?? "").split(".").pop().toLowerCase();
  const isPdf = b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46; // %PDF
  const isZip = b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04; // docx is a zip
  const isOle = b.length > 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0; // legacy .doc
  if (isPdf && ext === "pdf") return "pdf";
  if (isZip && ext === "docx") return "docx";
  if (isOle && ext === "doc") return "doc";
  return null;
}

function toBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
