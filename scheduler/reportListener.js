const admin = require('firebase-admin');
const { processDailyReport } = require('../services/reportService');

function startReportListener() {
  const db = admin.firestore();
  console.log('[Report] Setting up report request listener...');

  db.collectionGroup('reportRequests')
    .where('status', '==', 'pending')
    .onSnapshot(async (snapshot) => {
      console.log(`[Report] Snapshot received: ${snapshot.size} pending request(s), ${snapshot.docChanges().length} change(s)`);

      for (const change of snapshot.docChanges()) {
        if (change.type !== 'added') {
          continue;
        }

        const doc = change.doc;
        const data = doc.data();
        const uid = doc.ref.parent.parent.id;

        console.log(`[Report] New pending request detected: uid=${uid}, requestId=${doc.id}, type=${data.type}`);

        try {
          if (data.type === 'daily') {
            await processDailyReport(uid, { ...data, id: doc.id });
          } else {
            console.log(`[Report] Skipping non-daily request for uid=${uid}, requestId=${doc.id}, type=${data.type}`);
          }
          // weekly: skip for now
        } catch (err) {
          console.error('Report processing failed:', { uid, id: doc.id, err: err.message });
        }
      }
    }, (err) => {
      console.error('Report listener error:', err);
      console.log('[Report] Reconnecting report listener in 5 seconds...');
      setTimeout(startReportListener, 5000);
    });

  console.log('Report request listener started...');
}

module.exports = { startReportListener };
