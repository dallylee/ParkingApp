import * as admin from "firebase-admin";
import { onCall, HttpsError } from "firebase-functions/https";
import { ImageAnnotatorClient } from "@google-cloud/vision";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";

const vision = new ImageAnnotatorClient();

/**
 * Locked MVP schema
 */
const CaseSchema = z.object({
  operator: z.object({
    name: z.string().nullable(),
    appealUrl: z.string().nullable(),
    tradeBody: z.enum(["BPA", "IPC", "UNKNOWN"]),
  }),
  pcn: z.object({
    reference: z.string().nullable(),
    issueDate: z.string().nullable(), // YYYY-MM-DD
    incidentDate: z.string().nullable(), // YYYY-MM-DD
    startTime: z.string().nullable(), // HH:MM
    endTime: z.string().nullable(), // HH:MM
    location: z.string().nullable(),
    allegation: z.string().nullable(),
    amount: z.number().nullable(),
    discountAmount: z.number().nullable(),
    discountDeadline: z.string().nullable(), // YYYY-MM-DD
  }),
  evidenceFlags: z.object({
    payAndDisplayDetected: z.boolean(),
    bankProofDetected: z.boolean(),
  }),
  userAnswer: z.object({
    paidForThisVisit: z.enum(["YES", "NO", "NOT_SURE", "NOT_ASKED"]),
  }),
  safety: z.object({
    vrmPresent: z.enum(["FULL", "PARTIAL", "NONE"]),
    confidence: z.enum(["HIGH", "MEDIUM", "LOW"]),
    riskFlags: z.array(z.string()),
  }),
});

type ExtractedCase = z.infer<typeof CaseSchema>;

function normaliseTime(raw: string): string | null {
  const m = raw.match(/\b(\d{1,2}):(\d{2})(?::\d{2})?\b/);
  if (!m) return null;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

function basicEvidenceFlags(ocrText: string) {
  const t = ocrText.toLowerCase();

  const payAndDisplayDetected =
    t.includes("pay and display") ||
    t.includes("pay & display") ||
    t.includes("expiry") ||
    t.includes("purchased") ||
    t.includes("valid until");

  const bankProofDetected =
    t.includes("monzo") ||
    t.includes("starling") ||
    t.includes("transaction") ||
    t.includes("available balance") ||
    /\bvisa\b|\bmastercard\b|\bamex\b/i.test(ocrText);

  return { payAndDisplayDetected, bankProofDetected };
}

function vrmPresenceHeuristic(ocrText: string): "FULL" | "PARTIAL" | "NONE" {
  const candidates = ocrText.match(/\b[A-Z]{2}\d{2}\s?[A-Z]{3}\b/g);
  if (candidates && candidates.length > 0) return "FULL";

  const t = ocrText.toLowerCase();
  if (t.includes("vrm") || t.includes("vehicle reg") || t.includes("registration")) return "PARTIAL";

  return "NONE";
}

function getVertexClient() {
  const location = process.env.VERTEX_LOCATION || "europe-west2";
  const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;

  if (!projectId) {
    throw new Error("Missing GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT env var.");
  }

  return new GoogleGenAI({
    vertexai: true,
    project: projectId,
    location,
  });
}

function buildSchemaShape() {
  return JSON.stringify(
    {
      operator: { name: "string|null", appealUrl: "string|null", tradeBody: "BPA|IPC|UNKNOWN" },
      pcn: {
        reference: "string|null",
        issueDate: "YYYY-MM-DD|null",
        incidentDate: "YYYY-MM-DD|null",
        startTime: "HH:MM|null",
        endTime: "HH:MM|null",
        location: "string|null",
        allegation: "string|null",
        amount: "number|null",
        discountAmount: "number|null",
        discountDeadline: "YYYY-MM-DD|null",
      },
      evidenceFlags: { payAndDisplayDetected: "boolean", bankProofDetected: "boolean" },
      userAnswer: { paidForThisVisit: "YES|NO|NOT_SURE|NOT_ASKED" },
      safety: { vrmPresent: "FULL|PARTIAL|NONE", confidence: "HIGH|MEDIUM|LOW", riskFlags: "string[]" },
    },
    null,
    2
  );
}

function buildExtractionPrompt(ocrText: string) {
  const schemaJson = buildSchemaShape();

  const system = [
    "You are a data extraction engine for UK private parking documents (PCN, Notice to Keeper, pay-and-display tickets, bank screenshots).",
    "Return ONLY valid JSON. No markdown. No extra keys.",
    "Do not guess: use null if unknown.",
    "Dates must be YYYY-MM-DD. Times HH:MM (24h). If 10:32:49 appears use 10:32.",
    "tradeBody is BPA or IPC only if explicitly stated, otherwise UNKNOWN.",
    "riskFlags must be from: [missing_operator,missing_reference,missing_issue_date,missing_incident_date,missing_location,dates_unclear,times_unclear,amount_unclear,vrm_partial,low_confidence].",
    "Set confidence HIGH/MEDIUM/LOW based on clarity of core fields.",
  ].join("\n");

  const user = `OCR_TEXT:\n<<<\n${ocrText}\n>>>\n\nReturn JSON matching exactly this shape:\n${schemaJson}`;

  return `${system}\n\n${user}`;
}

function buildRepairPrompt(invalidJson: string) {
  const schemaJson = buildSchemaShape();

  const system = [
    "You fix JSON to match a required schema. Output ONLY valid JSON.",
    "Do not add extra keys. Replace unknown values with null.",
    "Ensure enums match required values.",
  ].join("\n");

  const user = `INVALID_JSON:\n<<<\n${invalidJson}\n>>>\n\nREQUIRED_SHAPE:\n<<<\n${schemaJson}\n>>>`;

  return `${system}\n\n${user}`;
}

export const extractFromUploads = onCall(
  { region: "europe-west2" },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Auth required");
    }

    const uid = request.auth.uid;
    const caseId = (request.data?.caseId as string) || "";

    if (!caseId) {
      throw new HttpsError("invalid-argument", "caseId required");
    }

    const db = admin.firestore();
    const caseRef = db.collection("cases").doc(caseId);

    const snap = await caseRef.get();
    if (!snap.exists) throw new HttpsError("not-found", "case not found");
    if (snap.data()?.uid !== uid) throw new HttpsError("permission-denied", "not your case");

    // List uploads in Storage
    const bucket = admin.storage().bucket();
    const prefix = `cases/${caseId}/uploads/`;
    const [files] = await bucket.getFiles({ prefix });

    const imageFiles = files.filter(
      (f) => !f.name.endsWith("/") && /\.(png|jpg|jpeg|webp)$/i.test(f.name)
    );

    if (imageFiles.length === 0) {
      throw new HttpsError("failed-precondition", "No uploads found for this case");
    }

    // OCR (limit to 6 images for cost control)
    let combinedText = "";
    for (const f of imageFiles.slice(0, 6)) {
      const [result] = await vision.textDetection(`gs://${bucket.name}/${f.name}`);
      const text =
        result?.fullTextAnnotation?.text ||
        result?.textAnnotations?.[0]?.description ||
        "";
      combinedText += `\n\n--- FILE: ${f.name} ---\n${text}`;
    }

    const evidenceFlags = basicEvidenceFlags(combinedText);
    const vrmPresent = vrmPresenceHeuristic(combinedText);

    const ai = getVertexClient();

    // 1) Extract strict JSON
    const prompt = buildExtractionPrompt(combinedText);

    const resp = await ai.models.generateContent({
      model: "gemini-1.5-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });

    const raw = resp.text ?? "";
    let parsed: any;

    try {
      parsed = JSON.parse(raw);
    } catch {
      // 2) One repair attempt
      const repairPrompt = buildRepairPrompt(raw);

      const repaired = await ai.models.generateContent({
        model: "gemini-1.5-flash",
        contents: [{ role: "user", parts: [{ text: repairPrompt }] }],
      });

      const raw2 = repaired.text ?? "";
      parsed = JSON.parse(raw2);
    }

    // Merge in safe heuristics (don’t let model “guess”)
    parsed.evidenceFlags = evidenceFlags;
    parsed.userAnswer = parsed.userAnswer || {};
    parsed.userAnswer.paidForThisVisit = "NOT_SURE"; // we will ask the single question in UX

    parsed.safety = parsed.safety || {};
    parsed.safety.vrmPresent = vrmPresent;

    // Normalise times if seconds provided
    if (parsed?.pcn?.startTime) parsed.pcn.startTime = normaliseTime(parsed.pcn.startTime) ?? parsed.pcn.startTime;
    if (parsed?.pcn?.endTime) parsed.pcn.endTime = normaliseTime(parsed.pcn.endTime) ?? parsed.pcn.endTime;

    // Validate
    let extracted: ExtractedCase;
    try {
      extracted = CaseSchema.parse(parsed);
    } catch (e: any) {
      throw new HttpsError("internal", `Schema validation failed: ${e?.message || e}`);
    }

    // Add risk flags defensively
    const riskFlags = new Set(extracted.safety.riskFlags || []);
    if (!extracted.operator.name) riskFlags.add("missing_operator");
    if (!extracted.pcn.reference) riskFlags.add("missing_reference");
    if (!extracted.pcn.issueDate) riskFlags.add("missing_issue_date");
    if (!extracted.pcn.incidentDate) riskFlags.add("missing_incident_date");
    if (!extracted.pcn.location) riskFlags.add("missing_location");
    if (vrmPresent === "PARTIAL") riskFlags.add("vrm_partial");
    extracted.safety.riskFlags = Array.from(riskFlags);

    await caseRef.set(
      {
        status: "extracted",
        extracted,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return { ok: true, extracted };
  }
);
