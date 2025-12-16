/**
 * One-command end-to-end test
 * Usage:
 *   node scripts/e2e_test.js "C:\path\to\image.jpg"
 */

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");
const { getFunctions } = require("firebase-functions-test")();

if (!process.argv[2]) {
  console.error("❌ Image path required");
  process.exit(1);
}

const IMAGE_PATH = process.argv[2];
const PROJECT_ID = "appealpack-uk-prod-101";
const BUCKET = `${PROJECT_ID}.firebasestorage.app`;

if (!fs.existsSync(IMAGE_PATH)) {
  console.error("❌ Image file not found:", IMAGE_PATH);
  process.exit(1);
}

// --- Init Admin ---
admin.initializeApp({
  projectId: PROJECT_ID,
  storageBucket: BUCKET,
});

const db = admin.firestore();
const bucket = admin.storage().bucket();

// --- Helpers ---
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Main ---
(async () => {
  console.log("🔎 E2E TEST START");

  // 1️⃣ Create test case
  const caseRef = db.collection("cases").doc();
  const caseId = caseRef.id;

  await caseRef.set({
    uid: "e2e-test",
    status: "created",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  console.log("✅ Case created:", caseId);

  // 2️⃣ Upload image
  const dest = `cases/${caseId}/uploads/test.jpg`;
  await bucket.upload(IMAGE_PATH, {
    destination: dest,
    contentType: "image/jpeg",
  });

  console.log("✅ Uploaded image to Storage");

  // 3️⃣ Call function
  const fn = getFunctions({
    projectId: PROJECT_ID,
    region: "europe-west2",
  }).wrap(require("../functions/lib/index").extractFromUploads);

  console.log("⏳ Calling extractFromUploads...");
  await fn(
    { caseId },
    { auth: { uid: "e2e-test" } }
  );

  // 4️⃣ Poll Firestore
  console.log("⏳ Waiting for extraction...");
  let extracted = false;

  for (let i = 0; i < 10; i++) {
    await sleep(2000);
    const snap = await caseRef.get();
    if (snap.data()?.status === "extracted") {
      extracted = true;
      console.log("🎉 EXTRACTION SUCCESS");
      console.log(JSON.stringify(snap.data().extracted, null, 2));
      break;
    }
  }

  if (!extracted) {
    console.error("❌ Extraction did not complete");
    process.exit(1);
  }

  // 5️⃣ Cleanup (comment out if you want to inspect)
  await bucket.deleteFiles({ prefix: `cases/${caseId}/` });
  await caseRef.delete();

  console.log("🧹 Cleanup complete");
  console.log("✅ E2E TEST PASSED");
  process.exit(0);
})().catch((err) => {
  console.error("💥 E2E TEST FAILED");
  console.error(err);
  process.exit(1);
});
