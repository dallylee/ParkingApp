 1 import * as functions from "firebase-functions";
     2 import * as admin from "firebase-admin";
     3 import * as stripe from "stripe";
     4 import * as puppeteer from "puppeteer";
     5 
     6 // Initialize Stripe and Firebase Admin
     7 import Stripe from "stripe";

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
if (!stripeSecretKey) {
  throw new Error("Missing STRIPE_SECRET_KEY environment variable");
}

const stripe = new Stripe(stripeSecretKey, {
  apiVersion: "2024-06-20",
});
    10 
    11 export const createCase = functions.https.onCall(async (data: any, context: functions.https.CallableContext) => {
    12   const db = admin.firestore();
    13   const docRef = await db.collection("cases").add({
    14     uid: "anonymous",
    15     status: "created",
    16     createdAt: admin.firestore.FieldValue.serverTimestamp(),
    17     updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    18   });
    19 
    20   return { caseId: docRef.id };
    21 });
    22 
    23 export const generateAppealPack = functions.https.onCall(async (data: { caseId: string, paidForThisVisit?: "YES" | "NO" | "NOT_SURE" }, context: functions.https.CallableContext) => {
    24   const { caseId, paidForThisVisit } = data;
    25   const db = admin.firestore();
    26   const caseRef = db.collection("cases").doc(caseId);
    27 
    28   const caseDoc = await caseRef.get();
    29   if (!caseDoc.exists) {
    30     throw new functions.https.HttpsError("not-found", "Case not found.");
    31   }
    32 
    33   const caseData = caseDoc.data()!;
    34   const extracted = caseData.extracted || {};
    35   const pcn = extracted.pcn || {};
    36 
    37   let appealLetterText = `[Your Name/Keeper Name]
    38 [Your Address]
    39 [Your City, Postcode]
    40 
    41 [Date]
    42 
    43 ${extracted.operator?.name || '[Parking Operator Name]'}
    44 ${extracted.operator?.appealUrl || '[Parking Operator Address]'}
    45 [Parking Operator City, Postcode]
    46 
    47 **Subject: Appeal Against Parking Charge Notice ${pcn.reference || '[PCN Reference]'}**
    48 
    49 Dear Sir/Madam,
    50 
    51 I am writing to formally appeal against Parking Charge Notice number ${pcn.reference || '[PCN Reference]'}, issued on ${pcn.issueDate || '[Issue Date]'} at ${pcn.location || '[Location]'
       I am the keeper of vehicle [VRM].
    52 
    53 `;
    54 
    55   let evidenceChecklist: string[] = [];
    56   let submissionSteps: string[] = [
    57     `Submit your appeal letter and evidence to the parking operator at their website: ${extracted.operator?.appealUrl || '[Operator Website]'}`,
    58     "Keep copies of everything you send and receive.",
    59     "If your appeal is rejected, consider appealing to POPLA (Parking on Private Land Appeals) or IAS (Independent Appeals Service).",
    60     "Do not pay the charge until the appeals process is complete, as this may invalidate your right to appeal further.",
    61   ];
    62 
    63   if (paidForThisVisit === "YES" || extracted.evidenceFlags?.payAndDisplayDetected) {
    64     appealLetterText += `I understand that the incident was for "${pcn.allegation || 'an alleged parking contravention'}". However, I believe this charge is unfair and should be cancelle
       because payment was made for the parking session.
    65 
    66 Please find evidence of payment attached. I request that you cancel this Parking Charge Notice.
    67 `;
    68     evidenceChecklist.push("A copy of your pay and display ticket or a screenshot of your payment confirmation.");
    69   } else {
    70     appealLetterText += `I am appealing as the keeper of the vehicle. I request that you provide evidence of the alleged contravention, including clear copies of all signage at the site.
    71 
    72 Until such evidence is provided, I contend that the charge is not properly issued. I request that you cancel this Parking Charge Notice.
    73 `;
    74     evidenceChecklist.push("A copy of the Parking Charge Notice you received.");
    75   }
    76 
    77   appealLetterText += `
    78 If you reject this appeal, please provide me with a POPLA (or IAS) verification code and details of how to appeal to them.
    79 
    80 Yours faithfully,
    81 
    82 [Your Name/Keeper Name]`;
    83 
    84   await caseRef.update({
    85     "outputs.appealLetterText": appealLetterText,
    86     "outputs.evidenceChecklist": evidenceChecklist,
    87     "outputs.submissionSteps": submissionSteps,
    88     status: "ready_to_generate",
    89     "inputs.paidForThisVisit": paidForThisVisit || 'NOT_ASKED',
    90     updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    91   });
    92 
    93   return { success: true };
    94 });
    95 
    96 export const createCheckoutSession = functions.https.onCall(async (data: { caseId: string }, context: functions.https.CallableContext) => {
    97   const { caseId } = data;
    98   const db = admin.firestore();
    99   const caseRef = db.collection("cases").doc(caseId);
   100 
   101   if (!context.rawRequest.headers.origin) {
   102     throw new functions.https.HttpsError("invalid-argument", "The function must be called from an App Check verified app.")
   103   }
   104 
   105   const session = await stripeClient.checkout.sessions.create({
   106     payment_method_types: ['card'],
   107     line_items: [{
   108       price_data: {
   109         currency: 'gbp',
   110         product_data: {
   111           name: 'Parking Appeal Pack',
   112           images: [], // Optional: add images
   113         },
   114         unit_amount: 999, // 9.99 GBP in pence
   115       },
   116       quantity: 1,
   117     }],
   118     mode: 'payment',
   119     success_url: `${context.rawRequest.headers.origin}/output?caseId=${caseId}&payment=success`,
   120     cancel_url: `${context.rawRequest.headers.origin}/payment?caseId=${caseId}&payment=cancelled`,
   121     metadata: {
   122       caseId: caseId,
   123     }
   124   });
   125 
   126   await caseRef.update({
   127     "payment.stripeSessionId": session.id,
   128     updatedAt: admin.firestore.FieldValue.serverTimestamp(),
   129   });
   130 
   131   return { checkoutUrl: session.url };
   132 });
   133 
   134 export const stripeWebhook = functions.https.onRequest(async (request, response) => {
   135   const sig = request.headers['stripe-signature'] as string;
   136   let event;
   137 
   138   try {
   139     event = stripeClient.webhooks.constructEvent(request.rawBody, sig, endpointSecret);
   140   } catch (err) {
   141     const errorMessage = err instanceof Error ? err.message : "Unknown error";
   142     response.status(400).send(`Webhook Error: ${errorMessage}`);
   143     return;
   144   }
   145 
   146   // Handle the event
   147   if (event.type === 'checkout.session.completed') {
   148     const session = event.data.object as any;
   149     const caseId = session.metadata.caseId;
   150 
   151     if (caseId) {
   152       const db = admin.firestore();
   153       const caseRef = db.collection("cases").doc(caseId);
   154       await caseRef.update({
   155         "payment.status": "paid",
   156         status: "paid",
   157         updatedAt: admin.firestore.FieldValue.serverTimestamp(),
   158       });
   159       console.log(`Successfully updated payment status for case: ${caseId}`);
   160     } else {
   161       console.error("Webhook received for checkout session with no caseId in metadata.");
   162     }
   163   }
   164 
   165   response.status(200).send();
   166 });
   167 
   168 export const renderPdf = functions.https.onCall(async (data: { caseId: string }, context: functions.https.CallableContext) => {
   169   const { caseId } = data;
   170   const db = admin.firestore();
   171   const caseRef = db.collection("cases").doc(caseId);
   172 
   173   const caseDoc = await caseRef.get();
   174   if (!caseDoc.exists) {
   175     throw new functions.https.HttpsError("not-found", "Case not found.");
   176   }
   177 
   178   const caseData = caseDoc.data()!;
   179   const appealLetterText = caseData.outputs?.appealLetterText;
   180 
   181   if (!appealLetterText) {
   182     throw new functions.https.HttpsError("failed-precondition", "Appeal letter not generated yet.");
   183   }
   184 
   185   let browser;
   186   try {
   187     browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
   188     const page = await browser.newPage();
   189 
   190     const htmlContent = `
   191       <!DOCTYPE html>
   192       <html>
   193       <head>
   194         <title>Appeal Pack - Case ${caseId}</title>
   195         <style>
   196           body { font-family: Arial, sans-serif; margin: 40px; }
   197           pre { white-space: pre-wrap; word-wrap: break-word; font-family: Arial, sans-serif; }
   198           h1 { color: #333; }
   199         </style>
   200       </head>
   201       <body>
   202         <h1>Parking Appeal Pack</h1>
   203         <h2>Case ID: ${caseId}</h2>
   204         <pre>${appealLetterText}</pre>
   205         <h3>Evidence Checklist:</h3>
   206         <ul>
   207           ${(caseData.outputs?.evidenceChecklist || []).map((item: string) => `<li>${item}</li>`).join('')}
   208         </ul>
   209         <h3>Next Steps:</h3>
   210         <ol>
   211           ${(caseData.outputs?.submissionSteps || []).map((item: string) => `<li>${item}</li>`).join('')}
   212         </ol>
   213       </body>
   214       </html>
   215     `;
   216 
   217     await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
   218     const pdfBuffer = await page.pdf({ format: 'A4' });
   219 
   220     await browser.close();
   221 
   222     const bucket = admin.storage().bucket();
   223     const filePath = `cases/${caseId}/outputs/appeal-pack.pdf`;
   224     const file = bucket.file(filePath);
   225 
   226     await file.save(pdfBuffer, {
   227       metadata: { contentType: 'application/pdf' },
   228     });
   229 
   230     const [url] = await file.getSignedUrl({
   231       action: 'read',
   232       expires: '03-09-2491',
   233     });
   234 
   235     await caseRef.update({
   236       "outputs.pdfPath": url,
   237       status: "generated",
   238       updatedAt: admin.firestore.FieldValue.serverTimestamp(),
   239     });
   240 
   241     return { pdfUrl: url };
   242   } catch (error) {
   243     console.error("Error generating or uploading PDF:", error);
   244     if (browser) await browser.close();
   245     throw new functions.https.HttpsError("internal", "Failed to render or upload PDF.");
   246   }
   247 });
   248 
   249 export const cleanupOldCases = functions.pubsub.schedule('every 24 hours').onRun(async (context) => {
   250     const db = admin.firestore();
   251     const storage = admin.storage();
   252     const CUTOFF_DAYS = 30;
   253     const cutoff = admin.firestore.Timestamp.fromDate(new Date(Date.now() - CUTOFF_DAYS * 24 * 60 * 60 * 1000));
   254 
   255     const oldCasesSnapshot = await db.collection('cases')
   256         .where('createdAt', '<', cutoff)
   257         .get();
   258 
   259     const deletePromises: Promise<any>[] = [];
   260 
   261     oldCasesSnapshot.forEach(doc => {
   262         const caseId = doc.id;
   263         console.log(`Deleting old case data for caseId: ${caseId}`);
   264 
   265         const bucket = storage.bucket();
   266         const uploadsPath = `cases/${caseId}/uploads`;
   267         const outputsPath = `cases/${caseId}/outputs`;
   268 
   269         deletePromises.push(
   270             bucket.deleteFiles({ prefix: uploadsPath }).then(() => console.log(`Deleted uploads for ${caseId}`))
   271         );
   272         deletePromises.push(
   273             bucket.deleteFiles({ prefix: outputsPath }).then(() => console.log(`Deleted outputs for ${caseId}`))
   274         );
   275 
   276         deletePromises.push(doc.ref.delete().then(() => console.log(`Deleted Firestore doc for ${caseId}`)));
   277     });
   278 
   279     await Promise.all(deletePromises);
   280     console.log('Old case cleanup complete.');
   281     return null;
   282 });