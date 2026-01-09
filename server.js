import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import OpenAI from "openai";

const app = express();
app.use(helmet());
app.use(express.json({ limit: "60kb" }));

// CORS: nur deine Funnel-Origin(s) zulassen
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // server-to-server / health checks
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error("CORS blocked: " + origin));
    },
    methods: ["POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"]
  })
);

// Rate limit
app.use(
  "/review-classify",
  rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false
  })
);

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const LABELS = [
  "Falsche Tatsachenbehauptung (§ 823 BGB)",
  "Verleumdung (§ 187 StGB)",
  "Üble Nachrede (§ 186 StGB)",
  "Beleidigung (§ 185 StGB)",
  "Kreditgefährdung (§ 824 BGB)",
  "Fake-Bewertungen laut Google-Richtlinie (z.B. keine Patientenbeziehung)"
];

function clamp01(x) {
  const n = Number(x);
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

app.get("/health", (_, res) => res.status(200).send("ok"));

app.post("/review-classify", async (req, res) => {
  try {
    const reviewText = String(req.body?.review_text || "").trim();
    if (reviewText.length < 40) return res.status(400).json({ error: "too_short" });

    // minimale Redaction (optional, aber sinnvoll)
    const redacted = reviewText
      .replace(/\b[\w.-]+@[\w.-]+\.\w+\b/g, "[EMAIL]")
      .replace(/\b(\+?\d[\d\s().-]{7,}\d)\b/g, "[PHONE]");

    const system = `
Du klassifizierst einen Google-Bewertungstext in genau EINEN der folgenden Gründe.
Gib zurück:
- best_label (muss exakt einem Label entsprechen)
- confidence (0..1)
- rationale_short (max 1 Satz)
- evidence_needed (max 1 Satz)
- ranked_labels: Top-3 Liste [{label, score}]
Keine Garantien, keine Rechtsberatung. Antworte ausschließlich JSON.

Labels:
${LABELS.map(x => "- " + x).join("\n")}
`.trim();

    const resp = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0,
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Bewertungstext:\n${redacted}` }
      ],
      response_format: { type: "json_object" }
    });

    let data;
    try {
      data = JSON.parse(resp.choices[0].message.content);
    } catch {
      return res.status(502).json({ error: "model_json_invalid" });
    }

    const payload = {
      best_label: String(data.best_label || ""),
      confidence: clamp01(data.confidence),
      rationale_short: String(data.rationale_short || "").slice(0, 240),
      evidence_needed: String(data.evidence_needed || "").slice(0, 240),
      ranked_labels: Array.isArray(data.ranked_labels) ? data.ranked_labels.slice(0, 3) : []
    };

    if (!LABELS.includes(payload.best_label)) {
      // Hard guardrail: falls Modell "halluziniert"
      payload.best_label = "Fake-Bewertungen laut Google-Richtlinie (z.B. keine Patientenbeziehung)";
      payload.confidence = 0.34;
      payload.rationale_short = "Uneindeutige Klassifikation; Standard-Empfehlung gewählt.";
      payload.evidence_needed = "Bitte konkrete Textstellen markieren und Kontext ergänzen.";
      payload.ranked_labels = [
        { label: payload.best_label, score: payload.confidence }
      ];
    }

    return res.json(payload);
  } catch (e) {
    return res.status(500).json({ error: "server_error", message: String(e?.message || e) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Listening on", port));
