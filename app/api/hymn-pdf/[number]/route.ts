import { NextRequest, NextResponse } from "next/server";
import { checkIpRate, clientIp } from "@/lib/rate-limit";

const SITE = "https://bibletoppt.com";
const REFERER = `${SITE}/hymn/sheet-music/`;
// Impersonate a real browser — the site 403s plain bots.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ number: string }> }
) {
  const { number } = await params;
  const n = parseInt(number, 10);
  if (!Number.isFinite(n) || n < 1 || n > 645) {
    return NextResponse.json({ error: "Hymn number must be 1–645" }, { status: 400 });
  }

  // Reuse the same per-IP rate limiter as the OMR route so one user can't
  // hammer the upstream site (or our queue) by spamming hymn fetches.
  const ipRate = checkIpRate(clientIp(req.headers), Date.now());
  if (!ipRate.ok) {
    return NextResponse.json(
      { error: ipRate.reason },
      { status: 429, headers: { "Retry-After": String(ipRate.retryAfter ?? 60) } }
    );
  }

  const padded = String(n).padStart(3, "0");

  // Step 1: get a short-lived JWT from the site's token endpoint.
  let token: string;
  try {
    const tokenRes = await fetch(
      `${SITE}/api/download/sheet-music?action=token&number=${padded}&format=pdf`,
      { headers: { "User-Agent": UA, Referer: REFERER + padded } }
    );
    if (!tokenRes.ok) throw new Error(`token ${tokenRes.status}`);
    const body = await tokenRes.json();
    if (typeof body?.token !== "string") throw new Error("no token in response");
    token = body.token;
  } catch (err) {
    return NextResponse.json(
      { error: `Could not fetch hymn sheet: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 }
    );
  }

  // Step 2: exchange the token for the actual PDF.
  let pdfRes: Response;
  try {
    pdfRes = await fetch(
      `${SITE}/api/download/sheet-music?token=${token}&format=pdf`,
      { headers: { "User-Agent": UA, Referer: REFERER + padded } }
    );
    if (!pdfRes.ok) throw new Error(`pdf ${pdfRes.status}`);
    const ct = pdfRes.headers.get("content-type") ?? "";
    if (!ct.includes("pdf")) throw new Error(`unexpected content-type: ${ct}`);
  } catch (err) {
    return NextResponse.json(
      { error: `Could not download PDF: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 }
    );
  }

  // Stream the PDF straight through with a safe filename.
  const filename = `${padded}.pdf`;
  return new NextResponse(pdfRes.body, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // Short cache: the token is ephemeral, but the PDF content for a given
      // hymn number never changes, so an edge cache miss once per hour is fine.
      "Cache-Control": "public, max-age=3600",
    },
  });
}
