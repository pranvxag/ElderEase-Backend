const admin = require('firebase-admin');
const twilio = require('twilio');
const { limitSmsText } = require('../utils/sms');

const twilioClient = process.env.TWILIO_ACCOUNT_SID
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

function buildSugarText(sugarData) {
  const parts = [];

  // Fasting data
  if (sugarData.fasting && sugarData.fasting.readings.length > 0) {
    const f = sugarData.fasting;
    if (f.readings.length === 1) {
      parts.push(`🩸 Fast: ${f.readings[0].level}`);
    } else {
      const timeStr = f.min.time ? ` (${f.min.time})` : '';
      parts.push(`🩸 Fast: ${f.avg}(avg) | ↓${f.min.level}${timeStr} | ↑${f.max.level}`);
    }
  }

  // Post food data
  if (sugarData.postFood && sugarData.postFood.readings.length > 0) {
    const pf = sugarData.postFood;
    if (pf.readings.length === 1) {
      parts.push(`🍽 Post Meal: ${pf.readings[0].level}`);
    } else {
      const timeStr = pf.min.time ? ` (${pf.min.time})` : '';
      parts.push(`🍽 Post Meal: ${pf.avg}(avg) | ↓${pf.min.level}${timeStr} | ↑${pf.max.level}`);
    }
  }

  return parts.join(' | ');
}

function buildReportMessage(userName, adherence, sugar) {
  const baseParts = [`ElderEase Daily📋 ${userName}`];

  if (adherence !== null) baseParts.push(`💊 Med: ${adherence}%`);
  
  const sugarText = buildSugarText(sugar);
  if (sugarText) baseParts.push(sugarText);

  let message = baseParts.join(' | ');
  if (message.length <= 150) {
    return limitSmsText(message);
  }

  // Fallback: try without timestamps
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
  
  if (sugar.fasting && sugar.fasting.readings.length > 0) {
    const f = sugar.fasting;
    if (f.readings.length === 1) {
      addPartIfFits(`🩸 Fast: ${f.readings[0].level}`);
    } else {
      addPartIfFits(`🩸 Fast: ${f.avg}(avg) | ↓${f.min.level} | ↑${f.max.level}`);
    }
  }

  if (sugar.postFood && sugar.postFood.readings.length > 0) {
    const pf = sugar.postFood;
    if (pf.readings.length === 1) {
      addPartIfFits(`🍽 Post Meal: ${pf.readings[0].level}`);
    } else {
      addPartIfFits(`🍽 Post Meal: ${pf.avg}(avg) | ↓${pf.min.level} | ↑${pf.max.level}`);
    }
  }

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
 * Get detailed sugar readings (fasting and postFood) for a user on a specific date
 * Returns individual readings with timestamps, avg, min, max
 * @param {string} uid
 * @param {string} dateKey - YYYY-MM-DD format
 * @returns {Promise<Object>} { fasting: {...}, postFood: {...} }
 */
async function getSugarReadings(uid, dateKey) {
  try {
    const db = admin.firestore();
    const snap = await db.collection(`users/${uid}/sugarlogs`).where('date', '==', dateKey).get();
    
    if (snap.empty) {
      console.log(`[Report] No sugar logs for ${uid} on ${dateKey}`);
      return { fasting: null, postFood: null };
    }

    const fasting = [];
    const postFood = [];

    snap.forEach(doc => {
      const data = doc.data();
      if (data.fasting && typeof data.fasting.level === 'number') {
        fasting.push(data.fasting);
      }
      if (data.postFood && typeof data.postFood.level === 'number') {
        postFood.push(data.postFood);
      }
    });

    const processReadings = (arr) => {
      if (arr.length === 0) return null;
      
      const sorted = [...arr].sort((a, b) => a.level - b.level);
      const avg = Math.round(arr.reduce((sum, r) => sum + r.level, 0) / arr.length);
      
      return {
        readings: arr,
        count: arr.length,
        avg,
        min: { level: sorted[0].level, time: sorted[0].time },
        max: { level: sorted[arr.length - 1].level, time: sorted[arr.length - 1].time }
      };
    };

    console.log(`[Report] Sugar logs for ${uid} on ${dateKey}: fasting=${fasting.length}, postFood=${postFood.length}`);
    
    return {
      fasting: processReadings(fasting),
      postFood: processReadings(postFood)
    };
  } catch (err) {
    console.error(`[Report] Error fetching sugar readings for ${uid} on ${dateKey}:`, err.message);
    return { fasting: null, postFood: null };
  }
}

/**
 * Get weekly sugar readings (all readings in the last 7 days)
 * @param {string} uid
 * @param {string} dateKey - YYYY-MM-DD format (end date, typically today)
 * @returns {Promise<Object>} { fasting: {...}, postFood: {...} }
 */
async function getWeeklySugarReadings(uid, dateKey) {
  try {
    const db = admin.firestore();
    
    // Calculate date 7 days ago from dateKey
    const [year, month, day] = dateKey.split('-');
    const endDate = new Date(`${year}-${month}-${day}`);
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - 6); // 7 days including today
    
    const startDateStr = startDate.toISOString().split('T')[0];
    
    console.log(`[Report] Fetching weekly sugar from ${startDateStr} to ${dateKey}`);
    
    const snap = await db.collection(`users/${uid}/sugarlogs`)
      .where('date', '>=', startDateStr)
      .where('date', '<=', dateKey)
      .get();
    
    const fasting = [];
    const postFood = [];
    
    snap.forEach(doc => {
      const data = doc.data();
      if (!data.date) return;
      
      if (data.fasting && typeof data.fasting.level === 'number') {
        fasting.push({
          level: data.fasting.level,
          date: data.date,
          time: data.fasting.time || null
        });
      }
      
      if (data.postFood && typeof data.postFood.level === 'number') {
        postFood.push({
          level: data.postFood.level,
          date: data.date,
          time: data.postFood.time || null
        });
      }
    });

    const processWeeklyReadings = (arr) => {
      if (arr.length === 0) return null;
      
      const sorted = [...arr].sort((a, b) => a.level - b.level);
      const avg = Math.round(arr.reduce((sum, r) => sum + r.level, 0) / arr.length);
      const minReading = sorted[0];
      const maxReading = sorted[arr.length - 1];
      
      return {
        count: arr.length,
        avg,
        readings: arr,
        min: { level: minReading.level, date: minReading.date, time: minReading.time },
        max: { level: maxReading.level, date: maxReading.date, time: maxReading.time }
      };
    };

    console.log(`[Report] Weekly sugar (${startDateStr} to ${dateKey}): fasting=${fasting.length}, postFood=${postFood.length}`);
    
    return {
      fasting: processWeeklyReadings(fasting),
      postFood: processWeeklyReadings(postFood)
    };
  } catch (err) {
    console.error(`[Report] Error fetching weekly sugar for ${uid}:`, err.message);
    return { fasting: null, postFood: null };
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
    const sugar = await getSugarReadings(uid, dateKey);
    
    console.log(`[Report] Data fetched for ${uid}:`, { adherence, fasting: sugar.fasting?.count, postFood: sugar.postFood?.count });
    
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

    // Fetch weekly sugar readings
    const sugarWeekly = await getWeeklySugarReadings(uid, dateKey);

    // Build weekly summary with high/low/timestamps
    const parts = [`ElderEase Weekly📋 ${userName}`];
    
    if (sugarWeekly.fasting) {
      const f = sugarWeekly.fasting;
      parts.push(`🩸 Fast: Avg ${f.avg} | ↓${f.min.level}@${f.min.date} | ↑${f.max.level}@${f.max.date}`);
    }
    
    if (sugarWeekly.postFood) {
      const pf = sugarWeekly.postFood;
      parts.push(`🍽 Post Meal: Avg ${pf.avg} | ↓${pf.min.level}@${pf.min.date} | ↑${pf.max.level}@${pf.max.date}`);
    }

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
        sourceRequest: requestDoc.id || null,
        fastingStats: sugarWeekly.fasting ? {
          count: sugarWeekly.fasting.count,
          avg: sugarWeekly.fasting.avg,
          min: sugarWeekly.fasting.min,
          max: sugarWeekly.fasting.max
        } : null,
        afterMealStats: sugarWeekly.afterMeal ? {
          count: sugarWeekly.afterMeal.count,
          avg: sugarWeekly.afterMeal.avg,
          min: sugarWeekly.afterMeal.min,
          max: sugarWeekly.afterMeal.max
        } : null
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
  getSugarReadings,
  getWeeklySugarReadings,
  processDailyReport,
  processWeeklyReport,
};
