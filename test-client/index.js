const { initializeApp } = require("firebase/app");
const { getAuth, signInAnonymously } = require("firebase/auth");
const { getFirestore, doc, setDoc, getDoc } = require("firebase/firestore");
const { getFunctions, httpsCallable } = require("firebase/functions");
const fs = require("node:fs");

// Replace with your real values from Firebase Web App config
const firebaseConfig = {
  apiKey: "AIzaSyBitCYoS2NdxxShx6dcQB8rZc2uKVXPTLY",
  authDomain: "appealpack-uk-prod-101.firebaseapp.com",
  projectId: "appealpack-uk-prod-101",
  appId: "1:885207380716:web:d845bf9e93a7f0f9e62bc9",
};

const REGION = "europe-west2";
const STORAGE_BUCKET = "appealpack-uk-prod-101.firebasestorage.app";

const LOCAL_IMAGE_PATH = process.argv[2];
if (!LOCAL_IMAGE_PATH) {
  console.error('Usage: node index.js "C:\\path\\to\\image.jpg"');
  process.exit(1);
}

async function uploadToStorage({ idToken, caseId, filePath }) {
  const bytes = fs.readFileSync(filePath);
  const filename = filePath.split("\\").pop();
  const objectPath = `cases/${caseId}/uploads/${Date.now()}-${filename}`;

  const url =
    `https://firebasestorage.googleapis.com/v0/b/${STORAGE_BUCKET}/o` +
    `?uploadType=media&name=${encodeURIComponent(objectPath)}`;

  if (typeof fetch !== "function") {
    throw new Error("Global fetch is not available. You are on Node 25 so this should not happen.");
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Firebase ${idToken}`,
      "Content-Type": "application/octet-stream",
    },
    body: bytes,
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Storage upload failed: ${res.status} ${res.statusText}\n${txt}`);
  }

  await res.json();
  return { objectPath };
}

async function run() {
  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getFirestore(app);
  const functions = getFunctions(app, REGION);

  // 1) Anonymous auth (required by your callable)
  const cred = await signInAnonymously(auth);
  const uid = cred.user.uid;
  const idToken = await cred.user.getIdToken();

  // 2) Create Firestore case doc (function checks snap.data().uid === uid)
  const caseId = `case_${Date.now()}`;
  await setDoc(doc(db, "cases", caseId), {
    uid,
    status: "draft",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  // 3) Upload one image
  const up = await uploadToStorage({ idToken, caseId, filePath: LOCAL_IMAGE_PATH });
  console.log("Uploaded:", up.objectPath);

  // 4) Call the function
  const extract = httpsCallable(functions, "extractFromUploads");
  const result = await extract({ caseId });

  console.log("Callable result:");
  console.dir(result.data, { depth: null });

  // 5) Verify Firestore updated
  const snap = await getDoc(doc(db, "cases", caseId));
  console.log("Firestore status:", snap.data()?.status);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
