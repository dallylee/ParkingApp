const fs = require("fs");
const { v4: uuid } = require("uuid");
const fetch = require("node-fetch");
const admin = require("firebase-admin");

const imagePath = process.argv[2];
if (!imagePath) {
  console.error("Image path required");
  process.exit(1);
}

admin.initializeApp({
  projectId: "appealpack-uk-prod-101",
  storageBucket: "appealpack-uk-prod-101.firebasestorage.app"
});

const db = admin.firestore();
const bucket = admin.storage().bucket();

(async () => {
  console.log("ðŸ”Ž E2E TEST START");

  const caseId = uuid();
  const caseRef = db.collection("cases").doc(caseId);

  await caseRef.set({
    uid: "e2e",
    status: "created",
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  console.log("âœ… Case created:", caseId);

  const dest = cases//uploads/test.jpg;
  await bucket.upload(imagePath, { destination: dest });
  console.log("âœ… Image uploaded");

  const token = await admin.auth().createCustomToken("e2e");

  const res = await fetch(
    "https://europe-west2-appealpack-uk-prod-101.cloudfunctions.net/extractFromUploads",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": Bearer 
      },
      body: JSON.stringify({ data: { caseId } })
    }
  );

  if (!res.ok) {
    const t = await res.text();
    throw new Error("Function call failed: " + t);
  }

  console.log("â³ Waiting for extractionâ€¦");

  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const snap = await caseRef.get();
    if (snap.data()?.status === "extracted") {
      console.log("ðŸŽ‰ SUCCESS");
      console.log(JSON.stringify(snap.data().extracted, null, 2));
      process.exit(0);
    }
  }

  throw new Error("Extraction did not complete");
})();
