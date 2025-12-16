/**
 * Local smoke test:
 * - Sign in anonymously
 * - Create a case doc with uid
 * - Upload an image to Storage
 * - Call extractFromUploads(caseId)
 * - Print extracted summary
 *
 * Run from: C:\PROJECTS\ParkingApp
 */

import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import { getFirestore, doc, setDoc, getDoc } from "firebase/firestore";
import { getStorage, ref, uploadBytes } from "firebase/storage";
import { getFunctions, httpsCallable } from "firebase/functions";
import fs from "node:fs/promises";
import path from "node:path";

const FIREBASE_CONFIG = {
  apiKey: "REPLACE_ME",
  authDomain: "appealpack-uk-prod-101.firebaseapp.com",
  projectId: "appealpack-uk-prod-101",
  storageBucket: "appealpack-uk-prod-101.firebasestorage.app",
  appId: "REPLACE_ME",
};

const REGION = "europe-west2";

// Change this to an actual local image file you have (jpg/png/webp)
const LOCAL_IMAGE_PATH = process.argv[2];

if (!LOCAL_IMAGE_PATH) {
  console.error("Usage: node scripts/smoke-test-extract.mjs <path-to-image>");
  process.exit(1);
}

async function main() {
  const app = initializeApp(FIREBASE_CONFIG);

  const auth = getAuth(app);
  const { user } = await signInAnonymously(auth);

  const uid = user.uid;
  const caseId = `case_${Date.now()}`;

  const db = getFirestore(app);
  const storage = getStorage(app);
  const functions = getFunctions(app, REGION);

  // 1) Create case doc (your function checks snap.data().uid === uid)
  await setDoc(doc(db, "cases", caseId), {
    uid,
    status: "draft",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  // 2) Upload image to Storage
  const bytes = await fs.readFile(LOCAL_IMAGE_PATH);
  const filename = path.basename(LOCAL_IMAGE_PATH);
  const storagePath = `cases/${caseId}/uploads/${Date.now()}-${filename}`;
  await uploadBytes(ref(storage, storagePath), bytes, { contentType: "image/jpeg" });

  // 3) Call function
  const fn = httpsCallable(functions, "extractFromUploads");
  const res = await fn({ caseId });

  console.log("Function OK:", res.data?.ok);
  console.log("Extracted operator:", res.data?.extracted?.operator?.name);
  console.log("Extracted location:", res.data?.extracted?.pcn?.location);
  console.log("Risk flags:", res.data?.extracted?.safety?.riskFlags);

  // 4) Verify Firestore updated
  const snap = await getDoc(doc(db, "cases", caseId));
  console.log("Firestore status:", snap.data()?.status);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
