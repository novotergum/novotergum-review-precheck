import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import OpenAI from "openai";

const app = express();

/* =========================
   BASIC MIDDLEWARE
========================= */
app.use(helmet());
app.use(express.json({ limit: "60kb" }));

/* =========================
   CORS – KORREKT & STABIL
========================= */
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(o => o.trim())
  .filter(Boolean);

const corsOptions = {
  origin: (origin, cb) => {
    // kein Origin = server-to-server, health checks, curl
    if (!origin) return cb(null, true);

    if (allowedOrigins.includes(origin)) {
      return cb(null, true);
    }

    // ❗ WICHTIG: kein Error werfen
    return cb(null, false);
  },
  methods: ["POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions)); // 🔑 Preflight explizit erlauben

/* =========================
   RATE LIMIT
========================= */
app.use(
  "/review-classify",
  rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false
  })
);

/* =========================
   OPENAI
========================= */
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const LABELS = [
  "Falsche Tatsachenbehauptung (§ 823 BGB)",
  "Verleumdung (§ 187 StGB)",
  "Üble Nachrede (§ 186 StGB)",
  "Beleidigung (§ 185 StGB)",
  "Kreditgefährdung (§ 824 BGB)",
  "Fake-Bewertungen laut Google-Richtlinie (z.B. keine Patientenbeziehung)"
];

const clamp01 = x => Math.max(0, Math.min(1, Number(x) || 0));

/* =========================
   HEALTH
========================= */
app.get("/health", (_, res) => res.send("ok"));

/* =========================
   CLASSIFY
========================= */
app.post("/review-classify", async (req, res) => {
  try {
    const reviewText = String(req.body?.review_text || "").trim();
    if (reviewText.length < 40) {
      return res.status(400).json({ error: "too_short" });
    }

    const redacted = reviewText
      .replace(/\b[\w.-]+@[\w.-]+\.\w+\b/g, "[EMAIL]")
      .replace(/\b(\+?\d[\d\s().-]{7,}\d)\b/g, "[PHONE]");

    const system = `
Du klassifizierst einen Google-Bewertungstext in genau EINEN der folgenden Gründe.
Gib ausschließlich JSON zurück mit:
- best_label
- confidence (0..1)
- rationale_short (max 1 Satz)
- evidence_needed (max 1 Satz)
- ranked_labels (Top 3)

Labels:
${LABELS.map(l => "- " + l).join("\n")}
`.trim();

    const resp = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Bewertungstext:\n${redacted}` }
      ]
    });

    let data;
    try {
      data = JSON.parse(resp.choices[0].message.content);
    } catch {
      return res.status(502).json({ error: "model_json_invalid" });
    }

    let payload = {
      best_label: String(data.best_label || ""),
      confidence: clamp01(data.confidence),
      rationale_short: String(data.rationale_short || "").slice(0, 240),
      evidence_needed: String(data.evidence_needed || "").slice(0, 240),
      ranked_labels: Array.isArray(data.ranked_labels)
        ? data.ranked_labels.slice(0, 3)
        : []
    };

    if (!LABELS.includes(payload.best_label)) {
      payload = {
        best_label: LABELS[5],
        confidence: 0.34,
        rationale_short: "Uneindeutige Klassifikation; Standard-Empfehlung gewählt.",
        evidence_needed: "Bitte konkrete Textstellen markieren und Kontext ergänzen.",
        ranked_labels: [{ label: LABELS[5], score: 0.34 }]
      };
    }

    res.json(payload);
  } catch (e) {
    res.status(500).json({
      error: "server_error",
      message: String(e?.message || e)
    });
  }
});

/* =========================
   START
========================= */
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("✅ review-precheck listening on", port);
});
