import { NextRequest, NextResponse } from "next/server";

const BUCKET =
  process.env.GCS_HYMNAL_BUCKET ?? "choir-player-500815-hymnal";

const VALID_COLLECTIONS = new Set(["chansonggah", "gracesong"]);

/**
 * Fetch a short-lived access token from the GCP metadata server.
 * Returns null when not running in GCP (local dev, CI) so callers can
 * gracefully fall through to OMR instead of crashing.
 */
async function getGcpAccessToken(): Promise<string | null> {
  try {
    const res = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      {
        headers: { "Metadata-Flavor": "Google" },
        signal: AbortSignal.timeout(2000),
      }
    );
    if (!res.ok) return null;
    const { access_token } = (await res.json()) as { access_token: string };
    return access_token;
  } catch {
    return null;
  }
}

/**
 * GET /api/hymn-musicxml/[collection]/[number]
 *
 * Returns a verified .mxl MusicXML archive for the requested hymn, fetched
 * from GCS at gs://BUCKET/musicxml/{collection}/{number}.mxl.
 *
 * Responds 404 when:
 *  - not running in GCP (local dev — metadata server unavailable)
 *  - no verified file has been uploaded for this hymn yet
 *
 * The caller (frontend fetchHymnSheet) should fall through to OMR on 404.
 *
 * To add a verified score for hymn N:
 *   gsutil cp hymn-102.mxl gs://choir-player-500815-hymnal/musicxml/chansonggah/102.mxl
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ collection: string; number: string }> }
) {
  const { collection, number } = await params;

  if (!VALID_COLLECTIONS.has(collection)) {
    return NextResponse.json({ error: "Unknown collection" }, { status: 400 });
  }

  const n = parseInt(number, 10);
  if (!Number.isFinite(n) || n < 1) {
    return NextResponse.json({ error: "Invalid hymn number" }, { status: 400 });
  }

  const token = await getGcpAccessToken();
  if (!token) {
    // Not running in GCP — no preset library available
    return NextResponse.json({ error: "No preset available" }, { status: 404 });
  }

  const objectPath = `musicxml/${collection}/${n}.mxl`;
  const gcsUrl = `https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(objectPath)}?alt=media`;

  const gcsRes = await fetch(gcsUrl, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });

  if (!gcsRes.ok) {
    return NextResponse.json({ error: "No preset available" }, { status: 404 });
  }

  const body = await gcsRes.arrayBuffer();
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.recordare.musicxml+xml",
      "Content-Disposition": `attachment; filename="${n}.mxl"`,
      "Cache-Control": "public, max-age=86400",
    },
  });
}
