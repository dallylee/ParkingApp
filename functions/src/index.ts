
import * as admin from "firebase-admin";
import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { ImageAnnotatorClient } from "@google-cloud/vision";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import Stripe from "stripe";
import { defineSecret } from "firebase-functions/params";

admin.initializeApp();

const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");
const stripeWebhookSecret = defineSecret("STRIPE_WEBHOOK_SECRET");

const REGION = "europe-west2";

const vision = new ImageAnnotatorClient();

const CaseSchema = z.object({
  operator: z.object({
    name: z.string().nullable(),
    appealUrl: z.string().nullable(),
    tradeBody: z.enum(["BPA", "IPC", "UNKNOWN"]),
  }),
  pcn: z.object({
    reference: z.string().nullable(),
    issueDate: z.string().nullable(),
    incidentDate: z.string().nullable(),
    startTime: z.string().nullable(),
    endTime: z.string().nullable(),
    location: z.string().nullable(),
    allegation: z.string().nullable(),
    amount: z.number().nullable(),
    discountAmount: z.number().nullable(),
    discountDeadline: z.string().nullable(),
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
  const payAndDisplayDetected = t.includes("pay and display") || t.includes("pay & display") || t.includes("expiry") || t.includes("purchased") || t.includes("valid until");
  const bankProofDetected = t.includes("monzo") || t.includes("starling") || t.includes("transaction") || t.includes("available balance") || /\bvisa\b|\bmastercard\b|\bamex\b/i.test(ocrText);
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
  if (!projectId) throw new Error("Missing GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT env var.");
  return new GoogleGenAI({ vertexai: true, project: projectId, location });
}

function buildSchemaShape() {
  return JSON.stringify({
    operator: { name: "string|null", appealUrl: "string|null", tradeBody: "BPA|IPC|UNKNOWN" },
    pcn: { reference: "string|null", issueDate: "YYYY-MM-DD|null", incidentDate: "YYYY-MM-DD|null", startTime: "HH:MM|null", endTime: "HH:MM|null", location: "string|null", allegation: "string|null", amount: "number|null", discountAmount: "number|null", discountDeadline: "YYYY-MM-DD|null" },
    evidenceFlags: { payAndDisplayDetected: "boolean", bankProofDetected: "boolean" },
    userAnswer: { paidForThisVisit: "YES|NO|NOT_SURE|NOT_ASKED" },
    safety: { vrmPresent: "FULL|PARTIAL|NONE", confidence: "HIGH|MEDIUM|LOW", riskFlags: "string[]" },
  }, null, 2);
}

function buildExtractionPrompt(ocrText: string) {
  const schemaJson = buildSchemaShape();
  const system = [
    "You are a data extraction engine for UK private parking documents (PCN, Notice to Keeper, pay-and-display tickets, bank screenshots).",
    "Return ONLY valid JSON. No markdown. No extra keys.", "Do not guess: use null if unknown.",
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
  const system = ["You fix JSON to match a required schema. Output ONLY valid JSON.", "Do not add extra keys. Replace unknown values with null.", "Ensure enums match required values."].join("\n");
  const user = `INVALID_JSON:\n<<<\n${invalidJson}\n>>>\n\nREQUIRED_SHAPE:\n<<<\n${schemaJson}\n>>>`;
  return `${system}\n\n${user}`;
}

export const createCase = onCall({ region: REGION }, async (request) => {
  const db = admin.firestore();
  const docRef = await db.collection("cases").add({
    uid: "anonymous",
    status: "created",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { caseId: docRef.id };
});

export const generateAppealPack = onCall({ region: REGION }, async (request) => {
  const { caseId, paidForThisVisit } = request.data;
  const db = admin.firestore();
  const caseRef = db.collection("cases").doc(caseId);
  const caseDoc = await caseRef.get();
  if (!caseDoc.exists) throw new HttpsError("not-found", "Case not found.");

  const caseData = caseDoc.data()!;
  const extracted = caseData.extracted || {};
  const pcn = extracted.pcn || {};

  let appealLetterText = `[Your Name/Keeper Name]\n[Your Address]\n[Your City, Postcode]\n\n[Date]\n\n${extracted.operator?.name || '[Parking Operator Name]'}\n${extracted.operator?.appealUrl || '[Parking Operator Address]'}\n[Parking Operator City, Postcode]\n\n**Subject: Appeal Against Parking Charge Notice ${pcn.reference || '[PCN Reference]'}**\n\nDear Sir/Madam,\n\nI am writing to formally appeal against Parking Charge Notice number ${pcn.reference || '[PCN Reference]'}, issued on ${pcn.issueDate || '[Issue Date]'} at ${pcn.location || '[Location]'}. I am the keeper of vehicle [VRM].\n\n`;
  let evidenceChecklist: string[] = [];
  let submissionSteps: string[] = [
    `Submit your appeal letter and evidence to the parking operator at their website: ${extracted.operator?.appealUrl || '[Operator Website]'}`,
    "Keep copies of everything you send and receive.",
    "If your appeal is rejected, consider appealing to POPLA (Parking on Private Land Appeals) or IAS (Independent Appeals Service).",
    "Do not pay the charge until the appeals process is complete, as this may invalidate your right to appeal further.",
  ];

  if (paidForThisVisit === "YES" || extracted.evidenceFlags?.payAndDisplayDetected) {
    appealLetterText += `I understand that the incident was for "${pcn.allegation || 'an alleged parking contravention'}". However, I believe this charge is unfair and should be cancelled because payment was made for the parking session.\n\nPlease find evidence of payment attached. I request that you cancel this Parking Charge Notice.\n`;
    evidenceChecklist.push("A copy of your pay and display ticket or a screenshot of your payment confirmation.");
  } else {
    appealLetterText += `I am appealing as the keeper of the vehicle. I request that you provide evidence of the alleged contravention, including clear copies of all signage at the site.\n\nUntil such evidence is provided, I contend that the charge is not properly issued. I request that you cancel this Parking Charge Notice.\n`;
    evidenceChecklist.push("A copy of the Parking Charge Notice you received.");
  }

  appealLetterText += `\nIf you reject this appeal, please provide me with a POPLA (or IAS) verification code and details of how to appeal to them.\n\nYours faithfully,\n\n[Your Name/Keeper Name]`;

  await caseRef.update({
    "outputs.appealLetterText": appealLetterText,
    "outputs.evidenceChecklist": evidenceChecklist,
    "outputs.submissionSteps": submissionSteps,
    status: "ready_to_generate",
    "inputs.paidForThisVisit": paidForThisVisit || 'NOT_ASKED',
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { success: true };
});

export const createCheckoutSession = onCall({ region: REGION, secrets: [stripeSecretKey] }, async (request) => {
  const { caseId } = request.data;
  const db = admin.firestore();
  const caseRef = db.collection("cases").doc(caseId);

  const origin = request.rawRequest.headers.origin;
  if (!origin) throw new HttpsError("invalid-argument", "The function must be called from an App Check verified app.");

  const stripe = new Stripe(stripeSecretKey.value(), { apiVersion: "2024-06-20" });

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: 'gbp',
        product_data: { name: 'Parking Appeal Pack', images: [] },
        unit_amount: 999,
      },
      quantity: 1,
    }],
    mode: 'payment',
    success_url: `${origin}/output?caseId=${caseId}&payment=success`,
    cancel_url: `${origin}/payment?caseId=${caseId}&payment=cancelled`,
    metadata: { caseId: caseId },
  });

  await caseRef.update({
    "payment.stripeSessionId": session.id,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { checkoutUrl: session.url };
});

export const stripeWebhook = onRequest({ region: REGION, secrets: [stripeSecretKey, stripeWebhookSecret] }, async (request, response) => {
  const sig = request.headers['stripe-signature'] as string;
  const stripe = new Stripe(stripeSecretKey.value(), { apiVersion: "2024-06-20" });

  let event;
  try {
    event = stripe.webhooks.constructEvent(request.rawBody, sig, stripeWebhookSecret.value());
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    response.status(400).send(`Webhook Error: ${errorMessage}`);
    return;
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as any;
    const caseId = session.metadata.caseId;

    if (caseId) {
      const db = admin.firestore();
      const caseRef = db.collection("cases").doc(caseId);
      await caseRef.update({
        "payment.status": "paid",
        status: "paid",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log(`Successfully updated payment status for case: ${caseId}`);
    } else {
      console.error("Webhook received for checkout session with no caseId in metadata.");
    }
  }

  response.status(200).send();
});

export const cleanupOldCases = onSchedule({ region: REGION, schedule: 'every 24 hours' }, async (event) => {
  const db = admin.firestore();
  const storage = admin.storage();
  const CUTOFF_DAYS = 30;
  const cutoff = admin.firestore.Timestamp.fromDate(new Date(Date.now() - CUTOFF_DAYS * 24 * 60 * 60 * 1000));

  const oldCasesSnapshot = await db.collection('cases').where('createdAt', '<', cutoff).get();

  const deletePromises: Promise<any>[] = [];

  oldCasesSnapshot.forEach(doc => {
    const caseId = doc.id;
    console.log(`Deleting old case data for caseId: ${caseId}`);
    const bucket = storage.bucket();
    const uploadsPath = `cases/${caseId}/uploads`;
    const outputsPath = `cases/${caseId}/outputs`;
    deletePromises.push(bucket.deleteFiles({ prefix: uploadsPath }).then(() => console.log(`Deleted uploads for ${caseId}`)));
    deletePromises.push(bucket.deleteFiles({ prefix: outputsPath }).then(() => console.log(`Deleted outputs for ${caseId}`)));
    deletePromises.push(doc.ref.delete().then(() => console.log(`Deleted Firestore doc for ${caseId}`)));
  });

  await Promise.all(deletePromises);
  console.log('Old case cleanup complete.');
});

export const extractFromUploads = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Auth required");

  const uid = request.auth.uid;
  const caseId = (request.data?.caseId as string) || "";
  if (!caseId) throw new HttpsError("invalid-argument", "caseId required");

  const db = admin.firestore();
  const caseRef = db.collection("cases").doc(caseId);

  const snap = await caseRef.get();
  if (!snap.exists) throw new HttpsError("not-found", "case not found");
  if (snap.data()?.uid !== uid) throw new HttpsError("permission-denied", "not your case");

  const bucket = admin.storage().bucket();
  const prefix = `cases/${caseId}/uploads/`;
  const [files] = await bucket.getFiles({ prefix });

  const imageFiles = files.filter(f => !f.name.endsWith("/") && /\.(png|jpg|jpeg|webp)$/i.test(f.name));
  if (imageFiles.length === 0) throw new HttpsError("failed-precondition", "No uploads found for this case");

  let combinedText = "";
  for (const f of imageFiles.slice(0, 6)) {
    const [result] = await vision.textDetection(`gs://${bucket.name}/${f.name}`);
    const text = result?.fullTextAnnotation?.text || result?.textAnnotations?.[0]?.description || "";
    combinedText += `\n\n--- FILE: ${f.name} ---\n${text}`;
  }

  const evidenceFlags = basicEvidenceFlags(combinedText);
  const vrmPresent = vrmPresenceHeuristic(combinedText);

  const ai = getVertexClient();
  const prompt = buildExtractionPrompt(combinedText);

  const resp = await ai.models.generateContent({ model: "gemini-1.5-flash", contents: [{ role: "user", parts: [{ text: prompt }] }] });
  const raw = resp.text ?? "";
  let parsed: any;

  try {
    parsed = JSON.parse(raw);
  } catch {
    const repairPrompt = buildRepairPrompt(raw);
    const repaired = await ai.models.generateContent({ model: "gemini-1.5-flash", contents: [{ role: "user", parts: [{ text: repairPrompt }] }] });
    const raw2 = repaired.text ?? "";
    parsed = JSON.parse(raw2);
  }

  parsed.evidenceFlags = evidenceFlags;
  parsed.userAnswer = parsed.userAnswer || {};
  parsed.userAnswer.paidForThisVisit = "NOT_SURE";
  parsed.safety = parsed.safety || {};
  parsed.safety.vrmPresent = vrmPresent;

  if (parsed?.pcn?.startTime) parsed.pcn.startTime = normaliseTime(parsed.pcn.startTime) ?? parsed.pcn.startTime;
  if (parsed?.pcn?.endTime) parsed.pcn.endTime = normaliseTime(parsed.pcn.endTime) ?? parsed.pcn.endTime;

  let extracted: ExtractedCase;
  try {
    extracted = CaseSchema.parse(parsed);
  } catch (e: any) {
    throw new HttpsError("internal", `Schema validation failed: ${e?.message || e}`);
  }

  const riskFlags = new Set(extracted.safety.riskFlags || []);
  if (!extracted.operator.name) riskFlags.add("missing_operator");
  if (!extracted.pcn.reference) riskFlags.add("missing_reference");
  if (!extracted.pcn.issueDate) riskFlags.add("missing_issue_date");
  if (!extracted.pcn.incidentDate) riskFlags.add("missing_incident_date");
  if (!extracted.pcn.location) riskFlags.add("missing_location");
  if (vrmPresent === "PARTIAL") riskFlags.add("vrm_partial");
  extracted.safety.riskFlags = Array.from(riskFlags);

  await caseRef.set({
    status: "extracted",
    extracted,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  return { ok: true, extracted };
});
