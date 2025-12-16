# ================= CONFIG =================
$PROJECT_ID = "appealpack-uk-prod-101"
$REGION = "europe-west2"

if ($args.Count -lt 1) {
  Write-Error "Usage: e2e_run.ps1 <image-path>"
  exit 1
}

$IMAGE_PATH = $args[0]

if (!(Test-Path $IMAGE_PATH)) {
  Write-Error "Image file not found: $IMAGE_PATH"
  exit 1
}

# ================= SETUP =================
$E2E_DIR = "scripts\e2e"
New-Item -ItemType Directory -Force -Path $E2E_DIR | Out-Null
Set-Location $E2E_DIR

if (!(Test-Path "package.json")) {
  npm init -y | Out-Null
}

npm install firebase-admin node-fetch@2 uuid | Out-Null

# ================= WRITE E2E SCRIPT =================
@"
const { v4: uuid } = require("uuid");
const fetch = require("node-fetch");
const admin = require("firebase-admin");

const imagePath = process.argv[2];
if (!imagePath) {
  console.error("Image path required");
  process.exit(1);
}

admin.initializeApp({
  projectId: "$PROJECT_ID",
  storageBucket: "$PROJECT_ID.firebasestorage.app"
});

const db = admin.firestore();
const bucket = admin.storage().bucket();

(async () => {
  console.log("🔎 E2E TEST START");

  const caseId = uuid();
  const ref = db.collection("cases").doc(caseId);

  await ref.set({
    uid: "e2e",
    status: "created",
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  console.log("✅ Case created:", caseId);

  await bucket.upload(imagePath, {
    destination: `cases/${caseId}/uploads/test.jpg`
  });

  console.log("✅ Image uploaded");

  const token = await admin.auth().createCustomToken("e2e");

  const res = await fetch(
    "https://$REGION-$PROJECT_ID.cloudfunctions.net/extractFromUploads",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ data: { caseId } })
    }
  );

  if (!res.ok) {
    throw new Error(await res.text());
  }

  console.log("⏳ Waiting for extraction…");

  for (let i =
