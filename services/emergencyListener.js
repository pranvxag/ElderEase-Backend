const admin = require('firebase-admin');
const twilio = require('twilio');

const twilioClient = process.env.TWILIO_ACCOUNT_SID ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN) : null;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function startEmergencyListener() {
    console.log('Emergency Listener started...');

    // We assume firebase-admin is initialized in callerService or server.js
    // but just to be safe, we check if apps exist inside the callback, or here.
    if (!admin.apps.length) {
        console.warn('Firebase admin not initialized, Emergency Listener might fail if not initialized soon.');
    }

    try {
        const db = admin.firestore();

        db.collection('emergencyEvents')
            .where('callStatus', '==', 'pending')
            .onSnapshot(snapshot => {
                snapshot.docChanges().forEach(async (change) => {
                    if (change.type === 'added' || change.type === 'modified') {
                        const eventId = change.doc.id;
                        const eventData = change.doc.data();

                        // Double check status to avoid infinite loops if modified events come in
                        if (eventData.callStatus !== 'pending') return;

                        console.log(`Processing emergency event: ${eventId}`);

                        try {
                            // 1. Immediately update status to processing to prevent duplicate triggers
                            await db.collection('emergencyEvents').doc(eventId).update({
                                callStatus: 'processing'
                            });

                            const { userId, userName, userPhone, date, time, location } = eventData;

                            // 2. Fetch emergency contacts
                            const profileDoc = await db.collection('users').doc(userId).collection('profile').doc('data').get();
                            let contacts = [];
                            if (profileDoc.exists) {
                                const profileData = profileDoc.data();
                                contacts = profileData.emergencyContacts || [];
                            }

                            // 3. Sort contacts: isPrimary: true first
                            contacts.sort((a, b) => (b.isPrimary === true) - (a.isPrimary === true));

                            const doctorContact = contacts.find(c => c.relation && c.relation.toLowerCase() === 'doctor');
                            const doctorPhone = doctorContact ? doctorContact.phone : null;

                            if (!twilioClient) {
                                console.warn('Twilio not configured, skipping calls and SMS.');
                            } else {
                                // 4. Sequential Voice Calls
                                for (const contact of contacts) {
                                    if (!contact.phone) continue;

                                    try {
                                        const twiml = `<Response><Say>Emergency Alert. ${userName} needs help. Emergency button was pressed at ${time} on ${date}. Please respond immediately.</Say></Response>`;

                                        await twilioClient.calls.create({
                                            twiml: twiml,
                                            to: contact.phone,
                                            from: process.env.TWILIO_PHONE_NUMBER
                                        });

                                        console.log(`Initiated emergency call to ${contact.name} (${contact.phone})`);

                                        // Add to contactsNotified array
                                        await db.collection('emergencyEvents').doc(eventId).update({
                                            contactsNotified: admin.firestore.FieldValue.arrayUnion(contact)
                                        });
                                    } catch (callErr) {
                                        console.error(`Failed to call emergency contact ${contact.phone}:`, callErr);
                                    }

                                    // Wait 10 seconds between each call
                                    await delay(10000);
                                }

                                // 5. Send SMS to all contacts after all calls are done
                                let locationStr = "Location unavailable";
                                if (location && location.latitude && location.longitude) {
                                    locationStr = `https://maps.google.com/?q=${location.latitude},${location.longitude}`;
                                }

                                let smsBody = `🚨 EMERGENCY ALERT 🚨\n${userName} needs help!\n\n📞 User Phone: ${userPhone}\n🕐 Time: ${time} on ${date}\n📍 Location: ${locationStr}\n`;

                                if (doctorPhone) {
                                    smsBody += `\n👨⚕️ Doctor: ${doctorPhone}\n`;
                                }

                                smsBody += `\nPlease respond immediately.`;

                                for (const contact of contacts) {
                                    if (!contact.phone) continue;
                                    try {
                                        await twilioClient.messages.create({
                                            body: smsBody,
                                            from: process.env.TWILIO_PHONE_NUMBER,
                                            to: contact.phone
                                        });
                                        console.log(`Sent emergency SMS to ${contact.name} (${contact.phone})`);
                                    } catch (smsErr) {
                                        console.error(`Failed to send emergency SMS to ${contact.phone}:`, smsErr);
                                    }
                                }
                            }

                            // 6. Update event document to completed
                            await db.collection('emergencyEvents').doc(eventId).update({
                                callStatus: 'completed',
                                completedAt: new Date().toISOString()
                            });

                            console.log(`Emergency event ${eventId} processed completely.`);

                        } catch (err) {
                            console.error(`Error processing emergency event ${eventId}:`, err);
                        }
                    }
                });
            }, err => {
                console.error('Error in emergency listener snapshot:', err);
            });
    } catch (err) {
        console.error('Failed to setup emergency listener (is Firebase initialized?):', err);
    }
}

module.exports = { startEmergencyListener };
