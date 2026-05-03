const admin = require('firebase-admin');
const twilio = require('twilio');
const { getISOStringIST } = require('../utils/istTime');
const { limitSmsText } = require('../utils/sms');

const twilioClient = process.env.TWILIO_ACCOUNT_SID ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN) : null;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function setupListener() {
    try {
        const db = admin.firestore();
        console.log('Firestore instance created, setting up listener...');

        db.collectionGroup('emergencyEvents')
            .where('callStatus', '==', 'pending')
            .onSnapshot(snapshot => {
                // 🔍 Debug logs
                console.log(`[Emergency] Snapshot received! Total docs: ${snapshot.size}`);
                console.log(`[Emergency] Doc changes: ${snapshot.docChanges().length}`);

                snapshot.docChanges().forEach(async (change) => {
                    // 🔍 Debug logs
                    console.log(`[Emergency] Change type: ${change.type}, Doc ID: ${change.doc.id}`);
                    console.log(`[Emergency] Data:`, JSON.stringify(change.doc.data()));

                    if (change.type === 'added' || change.type === 'modified') {
                        const eventId = change.doc.id;
                        const userId = change.doc.ref.parent.parent.id;
                        const eventData = change.doc.data();

                        // Double check status to avoid infinite loops
                        if (eventData.callStatus !== 'pending') {
                            console.log(`[Emergency] Skipping event ${eventId} - status is ${eventData.callStatus}`);
                            return;
                        }

                        console.log(`[Emergency] Processing emergency event: ${eventId}`);

                        try {
                            // 1. Immediately update status to processing
                            await change.doc.ref.update({
                                callStatus: 'processing'
                            });
                            console.log(`[Emergency] Event ${eventId} marked as processing`);

                            const { userName, userPhone, date, time, location } = eventData;

                            console.log(`[Emergency] Fetching contacts for userId: ${userId}`);

                            // 2. Fetch emergency contacts
                            const profileDoc = await db.collection('users').doc(userId).collection('profile').doc('data').get();
                            let contacts = [];
                            if (profileDoc.exists) {
                                const profileData = profileDoc.data();
                                contacts = profileData.emergencyContacts || [];
                                console.log(`[Emergency] Found ${contacts.length} emergency contacts`);
                            } else {
                                console.warn(`[Emergency] Profile doc not found for userId: ${userId}`);
                            }

                            // 3. Sort contacts: isPrimary: true first
                            contacts.sort((a, b) => (b.isPrimary === true) - (a.isPrimary === true));

                            const doctorContact = contacts.find(c => c.relation && c.relation.toLowerCase() === 'doctor');
                            const doctorPhone = doctorContact ? doctorContact.phone : null;

                            if (!twilioClient) {
                                console.warn('[Emergency] Twilio not configured, skipping calls and SMS.');
                            } else {
                                console.log(`[Emergency] Starting sequential calls to ${contacts.length} contacts...`);

                                // 4. Sequential Voice Calls
                                for (const contact of contacts) {
                                    if (!contact.phone) {
                                        console.warn(`[Emergency] Contact ${contact.name} has no phone, skipping.`);
                                        continue;
                                    }

                                    try {
                                        console.log(`[Emergency] Calling ${contact.name} at ${contact.phone}...`);

                                        const twiml = `<Response><Say>Emergency Alert. ${userName} needs help. Emergency button was pressed at ${time} on ${date}. Please respond immediately.</Say></Response>`;

                                        await twilioClient.calls.create({
                                            twiml: twiml,
                                            to: contact.phone,
                                            from: process.env.TWILIO_PHONE_NUMBER
                                        });

                                        console.log(`[Emergency] ✅ Initiated emergency call to ${contact.name} (${contact.phone})`);

                                        // Add to contactsNotified array
                                        await change.doc.ref.update({
                                            contactsNotified: admin.firestore.FieldValue.arrayUnion(contact)
                                        });
                                    } catch (callErr) {
                                        console.error(`[Emergency] ❌ Failed to call ${contact.phone}:`, callErr);
                                    }

                                    // Wait 10 seconds between each call
                                    console.log(`[Emergency] Waiting 10 seconds before next call...`);
                                    await delay(10000);
                                }

                                // 5. Send SMS to all contacts
                                let locationStr = "unavailable";
                                if (location && location.latitude && location.longitude) {
                                    const lat = location.latitude.toFixed(5);
                                    const lng = location.longitude.toFixed(5);
                                    locationStr = `maps.google.com/?q=${lat},${lng}`;
                                }

                                let smsBody = `🆘 EMERGENCY! ${userName} needs help!\n`;
                                smsBody += `📍 ${locationStr}\n`;
                                smsBody += `🕐 ${time}`;

                                if (doctorPhone) {
                                    smsBody += `\n👨‍⚕️ Dr: ${doctorPhone}`;
                                }

                                smsBody = limitSmsText(smsBody);

                                console.log(`[Emergency] Sending SMS to ${contacts.length} contacts...`);
                                console.log(`[Emergency] Using TWILIO_PHONE_NUMBER: ${process.env.TWILIO_PHONE_NUMBER}`);

                                for (const contact of contacts) {
                                    if (!contact.phone) {
                                        console.warn(`[Emergency] Skipping ${contact.name} - no phone number`);
                                        continue;
                                    }
                                    try {
                                        console.log(`[Emergency] Attempting SMS to ${contact.name} at ${contact.phone}...`);
                                        await twilioClient.messages.create({
                                            body: smsBody,
                                            from: process.env.TWILIO_PHONE_NUMBER,
                                            to: contact.phone
                                        });
                                        console.log(`[Emergency] ✅ Sent emergency SMS to ${contact.name} (${contact.phone})`);
                                    } catch (smsErr) {
                                        console.error(`[Emergency] ❌ Failed to send SMS to ${contact.phone}:`, smsErr.message);
                                    }
                                }
                            }

                            // 6. Update event to completed
                            await change.doc.ref.update({
                                callStatus: 'completed',
                                completedAt: getISOStringIST()
                            });

                            console.log(`[Emergency] ✅ Event ${eventId} processed completely.`);

                        } catch (err) {
                            console.error(`[Emergency] ❌ Error processing event ${eventId}:`, err);
                        }
                    }
                });
            }, err => {
                console.error('[Emergency] Snapshot error, reconnecting in 5s...', err);
                setTimeout(() => setupListener(), 5000);
            });

        console.log('[Emergency] Listener is now watching emergencyEvents subcollections under all users...');

    } catch (err) {
        console.error('[Emergency] Failed to setup emergency listener:', err);
    }
}

function startEmergencyListener() {
    console.log('Emergency Listener started...');

    if (!admin.apps.length) {
        console.warn('Firebase admin not initialized, Emergency Listener might fail if not initialized soon.');
    }

    // Setup the listener
    setupListener();

    // Add heartbeat
    setInterval(() => {
        console.log('[Emergency] Listener heartbeat - still active ✅');
    }, 5 * 60 * 1000);
}

module.exports = { startEmergencyListener };