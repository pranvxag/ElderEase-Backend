const admin = require('firebase-admin');
const twilio = require('twilio');
const { limitSmsText } = require('../utils/sms');

const twilioClient = process.env.TWILIO_ACCOUNT_SID
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

function buildReportMessage(userName, adherence, sugar) {
  const baseParts = [`ElderEase Daily📋 ${userName}`];

  if (adherence !== null) baseParts.push(`💊 Med: ${adherence}%`);
  if (sugar.fasting !== null) baseParts.push(`🩸 Fast: ${sugar.fasting}`);
  if (sugar.afterMeal !== null) baseParts.push(`🍽 PM: ${sugar.afterMeal}`);

  let message = baseParts.join(' | ');
  if (message.length <= 150) {
    return limitSmsText(message);
  }

  const parts = [`ElderEase Daily📋 ${userName}`];
  const addPartIfFits = (part) => {
    const candidate = [...parts, part].join(' | ');
    if (candidate.length <= 150) {
      parts.push(part);
      return true;
    }
    return false;
  };

  if (adherence !== null) addPartIfFits(`💊 Med: ${adherence}%`);
  if (sugar.fasting !== null) addPartIfFits(`🩸 Fast: ${sugar.fasting}`);
  if (sugar.afterMeal !== null) addPartIfFits(`🍽 PM: ${sugar.afterMeal}`);

  message = parts.join(' | ');

  if (message.length <= 150) {
    return limitSmsText(message);
  }

  const maxUserNameLength = Math.max(1, 150 - 'ElderEase Daily📋 '.length);
  const trimmedName = userName.slice(0, maxUserNameLength).trim();
  return limitSmsText(`ElderEase Daily📋 ${trimmedName}`);
}

/**
 * Fetch profile data for a user from users/{uid}/profile/data
 * @param {string} uid
 * @returns {Promise<Object|null>} Profile data or null if not found
 */
async function getProfileData(uid) {
  try {
    const db = admin.firestore();
    const snap = await db.doc(`users/${uid}/profile/data`).get();
    if (snap.exists) {
      console.log(`[Report] Loaded profile for ${uid}`);
      return snap.data();
    }
    console.warn(`[Report] Profile doc missing for ${uid}`);
    return null;
  } catch (err) {
    console.error(`[Report] Error fetching profile for ${uid}:`, err.message);
    return null;
  }
}

/**
 * Calculate medicine adherence percentage for a user on a specific date
 * @param {string} uid
 * @param {string} dateKey - YYYY-MM-DD format
 * @returns {Promise<number|null>} Percentage or null if no entries
 */
async function getMedicineAdherence(uid, dateKey) {
  try {
    const db = admin.firestore();
    const snap = await db.doc(`users/${uid}/medicinelogs/${dateKey}`).get();
    
    const entries = snap.data()?.entries ?? [];
    if (entries.length === 0) {
      console.log(`[Report] No medicine entries for ${uid} on ${dateKey}`);
      return null;
    }
    
    const taken = entries.filter(e => e.status === 'taken').length;
    const adherence = Math.round((taken / entries.length) * 100);
    console.log(`[Report] Medicine adherence for ${uid} on ${dateKey}: ${adherence}% (${taken}/${entries.length})`);
    return adherence;
  } catch (err) {
    console.error(`[Report] Error fetching medicine adherence for ${uid} on ${dateKey}:`, err.message);
    return null;
  }
}

/**
 * Calculate average blood sugar readings (fasting and after meal) for a user on a specific date
 * @param {string} uid
 * @param {string} dateKey - YYYY-MM-DD format
 * @returns {Promise<Object>} { fasting: number|null, afterMeal: number|null }
 */
async function getSugarAverages(uid, dateKey) {
  try {
    const db = admin.firestore();
    const snap = await db.collection(`users/${uid}/sugarlogs`).where('date', '==', dateKey).get();
    
    const fasting = [];
    const afterMeal = [];
    
    snap.forEach(doc => {
      const data = doc.data();
      if (data.type === 'fasting' && typeof data.level === 'number') {
        fasting.push(data.level);
      } else if (data.type === 'after_meal' && typeof data.level === 'number') {
        afterMeal.push(data.level);
      }
    });

    console.log(`[Report] Sugar logs for ${uid} on ${dateKey}: fasting=${fasting.length}, afterMeal=${afterMeal.length}`);
    
    const avg = (arr) => arr.length > 0 ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
    
    return {
      fasting: avg(fasting),
      afterMeal: avg(afterMeal),
    };
  } catch (err) {
    console.error(`[Report] Error fetching sugar averages for ${uid} on ${dateKey}:`, err.message);
    return { fasting: null, afterMeal: null };
  }
}

/**
 * Process a daily report request: fetch data, build SMS, send via Twilio, mark completed
 * @param {string} uid
 * @param {Object} requestDoc - { id, date, type, ... }
 */
async function processDailyReport(uid, requestDoc) {
  try {
    console.log(`[Report] Processing daily report for ${uid}:`, { id: requestDoc.id, date: requestDoc.date, type: requestDoc.type });
    
    // Convert date format from D/M/YYYY to YYYY-MM-DD (input is day/month/year)
    const [day, month, year] = requestDoc.date.split('/');
    const dateKey = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    console.log('[Report] dateKey generated:', dateKey);
    console.log(`[Report] Date converted: ${requestDoc.date} -> ${dateKey}`);
    
    // Fetch profile and contacts
    const profile = await getProfileData(uid);
    if (!profile) {
      console.warn(`[Report] No profile found for ${uid}, skipping report`);
      return;
    }
    
    const userName = profile?.displayName ?? profile?.name ?? 'Patient';
    const contacts = profile?.emergencyContacts ?? [];
    console.log(`[Report] Profile summary for ${uid}: userName=${userName}, contacts=${contacts.length}`);
    
    // Find primary caregiver and doctor
    const caregiver = contacts.find(c => c.slot === 'primary-caregiver') ?? 
                      contacts.find(c => c.isPrimary) ?? 
                      null;
    const doctor = contacts.find(c => c.slot === 'doctor') ?? null;
    console.log(`[Report] Selected recipients for ${uid}:`, {
      caregiver: caregiver?.phone || null,
      doctor: doctor?.phone || null,
    });
    
    // Fetch adherence and sugar data
    const adherence = await getMedicineAdherence(uid, dateKey);
    const sugar = await getSugarAverages(uid, dateKey);
    
    console.log(`[Report] Data fetched for ${uid}:`, { adherence, sugar });
    
    // Build SMS message (max 150 chars)
    const message = buildReportMessage(userName, adherence, sugar);
    console.log(`[Report] SMS message (${message.length} chars):`, message);
    
    // Send SMS to caregiver and doctor if phone numbers exist
    if (!twilioClient) {
      console.warn('[Report] Twilio not configured, skipping SMS send');
    } else {
      const phones = [];
      if (caregiver?.phone) phones.push({ name: 'Caregiver', phone: caregiver.phone });
      if (doctor?.phone) phones.push({ name: 'Doctor', phone: doctor.phone });

      console.log(`[Report] Sending report SMS to ${phones.length} recipient(s) for ${uid}`);
      
      for (const contact of phones) {
        try {
          await twilioClient.messages.create({
            to: contact.phone,
            from: process.env.TWILIO_PHONE_NUMBER,
            body: message
          });
          console.log(`[Report] Daily report SMS sent to ${contact.name}:`, contact.phone);
        } catch (err) {
          console.error(`[Report] Failed to send SMS to ${contact.name} (${contact.phone}):`, err.message);
        }
      }
    }
    
    // Mark request as completed
    const db = admin.firestore();
    await db.doc(`users/${uid}/reportRequests/${requestDoc.id}`).update({
      status: 'completed',
      processedAt: new Date().toISOString()
    });
    
    console.log(`[Report] ✅ Daily report completed for ${uid}:`, requestDoc.id);
    
  } catch (err) {
    console.error(`[Report] ❌ Error processing daily report for ${uid}:`, err.message);
    throw err;
  }
}

/**
 * Process a weekly report request: build short weekly summary, send SMS, persist summary, mark completed
 * @param {string} uid
 * @param {Object} requestDoc
 */
async function processWeeklyReport(uid, requestDoc) {
  try {
    console.log(`[Report] Processing weekly report for ${uid}:`, { id: requestDoc.id, date: requestDoc.date, type: requestDoc.type });

    // Normalize date if provided (accepts D/M/YYYY same as daily)
    let dateKey = null;
    if (requestDoc.date) {
      const parts = requestDoc.date.split('/');
      if (parts.length === 3) {
        const [day, month, year] = parts;
        dateKey = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
      }
    }

    const profile = await getProfileData(uid);
    if (!profile) {
      console.warn(`[Report] No profile found for ${uid}, skipping weekly report`);
      return;
    }

    const userName = profile?.displayName ?? profile?.name ?? 'Patient';
    const contacts = profile?.emergencyContacts ?? [];

    const caregiver = contacts.find(c => c.slot === 'primary-caregiver') ?? contacts.find(c => c.isPrimary) ?? null;
    const doctor = contacts.find(c => c.slot === 'doctor') ?? null;

    // For weekly we reuse the daily helpers; if dateKey is present use it, otherwise fetch latest day (null -> helpers return nulls)
    const adherence = dateKey ? await getMedicineAdherence(uid, dateKey) : null;
    const sugar = dateKey ? await getSugarAverages(uid, dateKey) : { fasting: null, afterMeal: null };

    // Build a concise weekly summary
    const parts = [`ElderEase Weekly📋 ${userName}`];
    if (adherence !== null) parts.push(`💊 AvgMed: ${adherence}%`);
    if (sugar.fasting !== null) parts.push(`🩸 FastAvg: ${sugar.fasting}`);
    if (sugar.afterMeal !== null) parts.push(`🍽 PMAvg: ${sugar.afterMeal}`);

    let message = parts.join(' | ');
    message = limitSmsText(message);

    console.log(`[Report] Weekly SMS message (${message.length} chars):`, message);

    if (!twilioClient) {
      console.warn('[Report] Twilio not configured, skipping weekly SMS send');
    } else {
      const phones = [];
      if (caregiver?.phone) phones.push({ name: 'Caregiver', phone: caregiver.phone });
      if (doctor?.phone) phones.push({ name: 'Doctor', phone: doctor.phone });

      console.log(`[Report] Sending weekly report SMS to ${phones.length} recipient(s) for ${uid}`);
      for (const contact of phones) {
        try {
          await twilioClient.messages.create({
            to: contact.phone,
            from: process.env.TWILIO_PHONE_NUMBER,
            body: message
          });
          console.log(`[Report] Weekly report SMS sent to ${contact.name}:`, contact.phone);
        } catch (err) {
          console.error(`[Report] Failed to send weekly SMS to ${contact.name} (${contact.phone}):`, err.message);
        }
      }
    }

    // Persist weekly summary
    try {
      const db = admin.firestore();
      const ref = await db.collection('users').doc(uid).collection('weeklyReports').add({
        generatedAt: new Date().toISOString(),
        summary: message,
        sourceRequest: requestDoc.id || null
      });
      console.log(`[Report] Weekly summary saved: ${ref.id}`);
    } catch (err) {
      console.error('[Report] Failed to persist weekly summary:', err.message);
    }

    // Mark request as completed
    try {
      const db2 = admin.firestore();
      await db2.doc(`users/${uid}/reportRequests/${requestDoc.id}`).update({
        status: 'completed',
        processedAt: new Date().toISOString()
      });
      console.log(`[Report] ✅ Weekly report completed for ${uid}:`, requestDoc.id);
    } catch (err) {
      console.error('[Report] Failed to mark weekly request completed:', err.message);
    }

  } catch (err) {
    console.error(`[Report] ❌ Error processing weekly report for ${uid}:`, err.message);
    throw err;
  }
}

module.exports = {
  getProfileData,
  getMedicineAdherence,
  getSugarAverages,
  processDailyReport,
  processWeeklyReport,
};
