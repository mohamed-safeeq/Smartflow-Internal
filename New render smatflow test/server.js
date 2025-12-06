import express from "express";
import OpenAI from "openai";
import fetch from "node-fetch";

// ==============================
// CONFIG
// ==============================
const WAIT_MS = 70_000;             // wait 70 sec for audio processing
const MIN_VALID_AUDIO = 200;        // minimum bytes required for transcription

// ==============================
// HELPERS
// ==============================
async function safeJson(res) {
  if (!res) return null;
  const text = await res.text();
  if (!text?.trim()) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function cleanNumber(n) {
  if (!n) return "";
  return String(n).replace(/\D/g, "");
}

function safeDecode(url) {
  try {
    const once = decodeURIComponent(url);
    if (once.startsWith("http")) return once;
  } catch {}
  return url;
}

// ==============================
// EXPRESS APP
// ==============================
const app = express();
app.use(express.text({ type: "*/*" })); // handle JSON + URL-encoded from Tata Tele

// ==============================
// MAIN ENDPOINT
// ==============================
app.post("/smartflow/zoho/internal", async (req, res) => {
  try {
    console.log("=== NEW WEBHOOK RECEIVED ===");

    // --- Parse body (JSON or x-www-form-urlencoded) ---
    let body;
    try { body = JSON.parse(req.body); }
    catch { body = Object.fromEntries(new URLSearchParams(req.body)); }

    const recordingUrlRaw = body.recording_url;
    const callType = body.call_type;
    const caller = body.caller_id_number;
    const callee = body.call_to_number;
    const callStart = body.start_stamp || "";
    const duration = body.billsec || body.duration || "0";
    const agent = body.answered_agent_name || "Unknown";

    if (!recordingUrlRaw)
      return res.status(400).json({ error: "recording_url missing" });

    if (!callType)
      return res.status(400).json({ error: "call_type missing" });

    const recordingUrl = safeDecode(recordingUrlRaw);
    const phone = cleanNumber(callType === "inbound" ? caller : callee);

    console.log(`CallType=${callType} Caller=${caller} Callee=${callee} Phone=${phone}`);

    // ---------------- Zoho Token ----------------
    const oauthURL =
      "https://accounts.zoho.in/oauth/v2/token?refresh_token=" + process.env.ZOHO_REFRESH +
      "&client_id=" + process.env.ZOHO_CLIENT +
      "&client_secret=" + process.env.ZOHO_SECRET +
      "&grant_type=refresh_token";

    const tokenJson = await safeJson(await fetch(oauthURL, { method: "POST" }));
    if (!tokenJson?.access_token)
      return res.status(502).json({ error: "Zoho Token Failed" });

    const zohoToken = tokenJson.access_token;

    // ---------------- CRM Search ----------------
    console.log("Searching CRM...");

    async function search(module, field, value) {
      const q = `select id from ${module} where ${field} like '%${value}%'`;
      const r = await fetch("https://www.zohoapis.in/crm/v5/coql", {
        method: "POST",
        headers: {
          "Authorization": `Zoho-oauthtoken ${zohoToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ select_query: q })
      });
      return safeJson(r);
    }

    const modules = ["Leads", "Deals"];
    const fields = ["Mobile", "Phone"];

    let moduleFound = null;
    let recordId = null;

    for (const mod of modules) {
      for (const field of fields) {
        const result = await search(mod, field, phone);
        if (result?.data?.length) {
          moduleFound = mod;
          recordId = result.data[0].id;
          break;
        }
      }
      if (recordId) break;
    }

    if (!recordId) {
      console.log("CRM not found");
      return res.json({ success: false, reason: "CRM not found" });
    }

    console.log(`CRM Match: ${moduleFound} → ${recordId}`);

    // ---------------- WAIT 70 sec ----------------
    await new Promise(r => setTimeout(r, WAIT_MS));

    // ---------------- DOWNLOAD AUDIO ----------------
    console.log("Downloading audio...");
    const audioRes = await fetch(recordingUrl, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    const buffer = await audioRes.arrayBuffer();
    const byteLen = buffer.byteLength;
    console.log("Audio Bytes =", byteLen);

    // ---------------- TRANSCRIPTION ----------------
    let transcript = null;

    if (byteLen > MIN_VALID_AUDIO) {
      try {
        console.log("Transcribing...");
        const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

        const file = new File([buffer], "call.mp3", { type: "audio/mpeg" });
        const resp = await client.audio.transcriptions.create({
          file,
          model: "gpt-4o-transcribe"
        });

        transcript = resp?.text?.trim() || null;
        console.log("Transcript:", transcript || "Transcript empty");

      } catch (err) {
        console.log("Transcription failed:", err?.message || err);
        transcript = null;
      }
    } else {
      console.log("Audio too small for transcription");
    }

    // ---------------- SAVE NOTE ----------------
    const noteContent =
`Phone: ${phone}
Agent: ${agent}
Start: ${callStart}
Duration: ${duration}s
Transcript:
${transcript || "Transcript not available."}
Recording URL: ${recordingUrl}
`;

    const notePayload = {
      data: [
        { Note_Title: `Call Summary (${callType})`, Note_Content: noteContent }
      ]
    };

    await fetch(
      `https://www.zohoapis.in/crm/v8/${moduleFound}/${recordId}/Notes`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${zohoToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(notePayload)
      }
    );

    console.log(`Note posted ${moduleFound} → ${recordId}`);

    return res.json({
      success: true,
      module: moduleFound,
      recordId,
      audioBytes: byteLen,
      transcriptPresent: !!transcript
    });

  } catch (err) {
    console.log("FATAL ERROR:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ==============================
// START SERVER
// ==============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
