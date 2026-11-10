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

const FIELD_LIMITS = {
  firstName: 80,
  lastName: 80,
  email: 200,
  phone: 40,
  city: 100,
  state: 60,
  position: 150,
  message: 4000,
};

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
  for (const [key, max] of Object.entries(FIELD_LIMITS)) {
    data[key] = String(form.get(key) ?? "").trim().slice(0, max);
  }

  if (!data.firstName || !data.lastName || !data.email || !data.phone) {
    return json({ ok: false, error: "missing-fields" }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
    return json({ ok: false, error: "invalid-email" }, 400);
  }

  const file = form.get("resume");
  if (!file || typeof file === "string" || !file.size) {
    return json({ ok: false, error: "missing-resume" }, 400);
  }
  if (file.size > MAX_FILE_BYTES) {
    return json({ ok: false, error: "file-too-large" }, 413);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = detectResumeType(bytes, file.name);
  if (!kind) {
    return json({ ok: false, error: "bad-file-type" }, 415);
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

  const fullName = `${data.firstName} ${data.lastName}`;
  const place = [data.city, data.state].filter(Boolean).join(", ");
  const safeName = fullName.replace(/[^A-Za-z0-9 ._-]/g, "").trim().replace(/\s+/g, "_") || "Applicant";
  const attachmentName = `${safeName}_Resume.${kind}`;

  const lines = [
    "New online application from transcableusa.com",
    "",
    `Name: ${fullName}`,
    `Email: ${data.email}`,
    `Phone: ${data.phone}`,
    `Location: ${place || "Not provided"}`,
    `Position of interest: ${data.position || "Not specified"}`,
    "",
    "Additional information:",
    data.message || "None provided",
    "",
    `Resume attached: ${attachmentName}`,
  ];

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
        subject: `Application: ${fullName}${data.position ? ` - ${data.position}` : ""}`,
        text: lines.join("\n"),
        attachments: [{ filename: attachmentName, content: toBase64(bytes) }],
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
