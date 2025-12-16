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
  const ref = db.collection("cases").doc(caseId);

  await ref.set({
    uid: "e2e",
    status: "created",
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  console.log("âœ… Case created:", caseId);

  await bucket.upload(imagePath, {
    destination: cases//uploads/test.jpg
  });

  console.log("âœ… Image uploaded");

  const token = await admin.auth().createCustomToken("e2e");

  const res = await fetch(
    "https://europe-west2-appealpack-uk-prod-101.cloudfunctions.net/extractFromUploads",
    {
      method: "POST",
      headers: {
        "Authorization": Bearer ,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ data: { caseId } })
    }
  );

  if (!res.ok) {
    throw new Error(await res.text());
  }

  console.log("â³ Waiting for extractionâ€¦");

  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const snap = await ref.get();
    if (snap.data()?.status === "extracted") {
      console.log("ðŸŽ‰ SUCCESS");
      console.log(JSON.stringify(snap.data().extracted, null, 2));
      process.exit(0);
    }
  }

  throw new Error("âŒ Extraction did not complete");
})();
