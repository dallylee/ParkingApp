const admin = require('firebase-admin');

admin.initializeApp({
  projectId: 'appealpack-uk-prod-101'
});

const db = admin.firestore();

db.collection('cases').doc('test-e2e-001').set({
  uid: 'test-user',
  status: 'uploaded',
  updatedAt: admin.firestore.FieldValue.serverTimestamp()
}).then(() => {
  console.log('✓ Case document created: test-e2e-001');
  process.exit(0);
}).catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
