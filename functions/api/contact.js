// Cloudflare Pages Function: contact form lead emailer via Resend.
// Set RESEND_API_KEY (and optionally CONTACT_TO) in the Pages project settings,
// or the form returns a friendly "not configured" message.
export async function onRequest(context) {
  if (context.request.method !== "POST") {
    return json({ ok: false, error: "method" }, 405);
  }

  let lead;
  try {
    lead = await context.request.json();
  } catch {
    return json({ ok: false, error: "bad-json" }, 400);
  }

  const firstName = String(lead.firstName ?? "").trim();
  const lastName = String(lead.lastName ?? "").trim();
  const email = String(lead.email ?? "").trim();
  const subject = String(lead.subject ?? "").trim();
  const message = String(lead.message ?? "").trim();

  if (!firstName || !lastName || !email || !subject || !message) {
    return json({ ok: false, error: "missing-fields" }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ ok: false, error: "invalid-email" }, 400);
  }

  const apiKey = context.env.RESEND_API_KEY;
  const toEmail = context.env.CONTACT_TO ?? "info@transcableusa.com";

  if (!apiKey) {
    return json(
      {
        ok: false,
        error: "not-configured",
        message:
          "The contact form is not yet connected to an email service. Please email info@transcableusa.com directly.",
      },
      503,
    );
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Trans Cable Website <onboarding@resend.dev>",
        to: [toEmail],
        reply_to: email,
        subject: `[Website] ${subject}`,
        text: `Name: ${firstName} ${lastName}\nEmail: ${email}\n\n${message}`,
      }),
    });
    if (!res.ok) return json({ ok: false, error: "send-failed", status: res.status }, 502);
    return json({ ok: true });
  } catch {
    return json({ ok: false, error: "send-failed" }, 502);
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}